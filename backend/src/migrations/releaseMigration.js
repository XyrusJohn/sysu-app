const {isDeepStrictEqual} = require('node:util');
const {initializeFirebase, admin} = require('../config/firebase');
const VERSION = 2;
const PAGE_SIZE = 100;

function validateOptions(kind, env) {
    if (!['line-items', 'driver-uid'].includes(kind)) throw new Error('Unknown migration');
    const project = env.FIREBASE_PROJECT_ID;
    if (!project || !/^[a-z][a-z0-9-]{4,62}$/.test(project) || env.MIGRATION_PROJECT_ID !== project) {
        throw new Error('Explicit matching Firebase and migration target projects are required');
    }
    const mode = env.MIGRATION_MODE || 'dry-run';
    if (!['dry-run', 'apply'].includes(mode)) throw new Error('MIGRATION_MODE must be dry-run or apply');
    if (mode === 'apply' && (env.MIGRATION_CONFIRM_PROJECT !== project
        || !/^[a-zA-Z0-9_-]{1,80}$/.test(env.MIGRATION_RUN_ID || ''))) {
        throw new Error('Apply requires an exact project confirmation and bounded migration run identifier');
    }
    const cursor = env.MIGRATION_START_AFTER || '';
    if (cursor.length > 1500 || cursor.includes('/')) throw new Error('Invalid migration resume cursor');
    return {kind, project, mode, runId:env.MIGRATION_RUN_ID, cursor};
}

function lineItemsPatch(data) {
    if (!Array.isArray(data.lineItems) || !data.lineItems.length) return {status:'unchanged'};
    if (data.lineItems.length > 1000) return {status:'unresolved'};
    const next = [];
    for (const item of data.lineItems) {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || typeof item.obdNumber !== 'string' || !item.obdNumber.trim() || item.obdNumber.length > 128
            || typeof item.customerName !== 'string' || !item.customerName.trim() || item.customerName.length > 500
            || !(typeof item.quantity === 'number' || (typeof item.quantity === 'string' && /^\d+(?:\.\d+)?$/.test(item.quantity)))) {
            return {status:'unresolved'};
        }
        const quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e9) return {status:'unresolved'};
        const transformed = {...item, quantity, customerName:item.customerName.trim()};
        delete transformed.amount;
        next.push(transformed);
    }
    return isDeepStrictEqual(next, data.lineItems) ? {status:'unchanged'} : {status:'change', patch:{lineItems:next}};
}

async function identityExists(uid) {
    try {await admin.auth().getUser(uid); return true;} catch (err) {
        if (err.code === 'auth/user-not-found') return false;
        throw err;
    }
}

async function driverUidPatch(data, id, read, db, lookupIdentity) {
    const current = data.driverId;
    if (typeof current !== 'string' || !current || current.length > 128 || current.includes('/')) return {status:'unresolved'};
    const queue = await read(db.collection('queue').doc(data.queueId || current));
    const queueData = queue.exists ? queue.data() : null;
    const currentIsUid = await lookupIdentity(current);
    const mapped = queueData?.driverId;
    if (currentIsUid && mapped && mapped !== current) return {status:'unresolved'};
    const patch = {};
    if (!currentIsUid) {
        if (typeof mapped !== 'string' || mapped === current || !await lookupIdentity(mapped)) return {status:'unresolved'};
        patch.driverId = mapped;
        patch.queueId = queue.id;
    }
    if (!('tripStatus' in data)) {
        const member = queueData?.assignedShipment?.dispatchKey === id
            || queueData?.assignedShipments?.some(item => item.dispatchKey === id);
        if (!member || !['assigned','loading','loaded','fully_loaded'].includes(queueData?.status)) return {status:'unresolved'};
        patch.tripStatus = queueData.status;
    }
    return Object.keys(patch).length ? {status:'change',patch} : {status:'unchanged'};
}

// Dependencies may be supplied by isolated tests; CLI always uses validated Firebase initialization.
async function runMigration({kind, env=process.env, db, initialize=()=>{initializeFirebase();return admin.firestore();},
    lookupIdentity=identityExists, applyDocument}) {
    const options = validateOptions(kind, env);
    const initialized = initialize();
    db = db || initialized;
    const summary = {kind, version:VERSION, project:options.project, mode:options.mode,
        scanned:0, changed:0, unchanged:0, unresolved:0, cursor:options.cursor};
    const collection = db.collection('sap_assignments');
    const plan = (data,id,read) => kind === 'line-items' ? lineItemsPatch(data)
        : driverUidPatch(data,id,read,db,lookupIdentity);
    let runRef;
    if (options.mode === 'apply' && !applyDocument) {
        runRef = db.collection('_migration_runs').doc(options.runId);
        await db.runTransaction(async tx => {
            const previous = await tx.get(runRef);
            if (previous.exists && (previous.data().kind !== kind || previous.data().project !== options.project || previous.data().version !== VERSION)) {
                throw new Error('Migration run identifier belongs to a different target or version');
            }
            if (!previous.exists) tx.create(runRef,{kind,project:options.project,version:VERSION,status:'running'});
        });
    }
    while (true) {
        let query = collection.orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE_SIZE);
        if (summary.cursor) query = query.startAfter(summary.cursor);
        const page = await query.get();
        if (page.empty) break;
        for (const doc of page.docs) {
            summary.scanned++;
            let outcome;
            if (options.mode === 'dry-run' || applyDocument) {
                outcome = await plan(doc.data(),doc.id,ref=>ref.get());
                if (options.mode === 'apply' && outcome.status === 'change') await applyDocument(doc,outcome.patch);
            } else {
                outcome = await db.runTransaction(async tx => {
                    const current = await tx.get(doc.ref);
                    if (!current.exists) return {status:'unchanged'};
                    const result = await plan(current.data(),doc.id,ref=>tx.get(ref));
                    if (result.status !== 'change') return result;
                    const backup = runRef.collection('records').doc(doc.id);
                    const previous = await tx.get(backup);
                    if (previous.exists) return {status:'unresolved'};
                    tx.create(backup,{sourcePath:doc.ref.path, before:current.data(), sourceUpdateTime:current.updateTime,
                        version:VERSION, kind, createdAt:admin.firestore.FieldValue.serverTimestamp()});
                    tx.update(doc.ref,result.patch);
                    return result;
                });
            }
            summary[outcome.status === 'change' ? 'changed' : outcome.status]++;
        }
        summary.cursor = page.docs.at(-1).id;
        if (runRef) await runRef.set({...summary,status:'running'}, {merge:true});
        if (page.size < PAGE_SIZE) break;
    }
    if (runRef) await runRef.set({...summary,status:summary.unresolved ? 'needs-reconciliation' : 'complete'}, {merge:true});
    return summary;
}

async function runMigrationCli(kind, env=process.env) {
    try {
        const result = await runMigration({kind,env});
        console.log(JSON.stringify(result)); // Counts only; no line items, names or credential fragments.
        if (result.unresolved) process.exitCode=2;
    } catch {
        console.error('Migration failed; no automatic recovery or success claim. Inspect the validated target and run checkpoint.');
        process.exitCode=1;
    } finally {
        for (const app of admin.apps) await app.delete();
    }
}
module.exports = {runMigration, runMigrationCli, lineItemsPatch};
