import {before, after, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
let db, runMigration;
before(() => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8085');
  admin.initializeApp({projectId:'demo-sysu-security'});
  db=admin.firestore();
  const path=require.resolve('../../src/config/firebase');
  require.cache[path]={id:path,filename:path,loaded:true,exports:{admin,initializeFirebase(){throw new Error('No implicit initialization in emulator tests');}}};
  ({runMigration}=require('../../src/migrations/releaseMigration'));
});
after(async()=>{await db?.terminate();await admin.app().delete();});
beforeEach(async()=>{
  for(const name of ['sap_assignments','_migration_runs','queue']) await db.recursiveDelete(db.collection(name));
});
const target={FIREBASE_PROJECT_ID:'demo-sysu-security',MIGRATION_PROJECT_ID:'demo-sysu-security'};
const apply={...target,MIGRATION_MODE:'apply',MIGRATION_CONFIRM_PROJECT:'demo-sysu-security',MIGRATION_RUN_ID:'synthetic-run'};
const item={obdNumber:'000001',quantity:'10.5',customerName:'Synthetic',amount:9};
function run(env=target,extra={}) {return runMigration({kind:'line-items',env,db,initialize(){},...extra});}
async function seedMany(count) {
  for(let first=0;first<count;first+=250) {
    const batch=db.batch();
    for(let n=first;n<Math.min(first+250,count);n++) batch.set(db.collection('sap_assignments').doc(`dispatch-${String(n).padStart(4,'0')}`),{driverId:'synthetic-driver',lineItems:[item]});
    await batch.commit();
  }
}
test('R29 more than 500 records: dry-run, paginated apply, atomic before images and idempotent rerun',async()=>{
  await seedMany(501);
  const dry=await run();
  assert.equal(dry.scanned,501);assert.equal(dry.changed,501);
  assert.equal((await db.collection('_migration_runs').get()).size,0);
  assert.equal((await db.collection('sap_assignments').doc('dispatch-0000').get()).data().lineItems[0].amount,9);
  const result=await run(apply);
  assert.equal(result.changed,501);
  const backups=await db.collection('_migration_runs').doc('synthetic-run').collection('records').get();
  assert.equal(backups.size,501);
  for(const backup of backups.docs) assert.deepEqual(backup.data().before.lineItems,[item]);
  const final=await db.collection('sap_assignments').get();
  for(const doc of final.docs) assert.deepEqual(doc.data().lineItems,[{obdNumber:'000001',quantity:10.5,customerName:'Synthetic'}]);
  assert.equal((await run(apply)).changed,0);
  assert.equal((await db.collection('_migration_runs').doc('synthetic-run').collection('records').get()).size,501);
});
test('R29 interrupted apply rolls back the failing document and safely resumes',async()=>{
  await seedMany(3);
  const original=db.runTransaction.bind(db);
  db.runTransaction=callback=>original(async tx=>{
    const update=tx.update.bind(tx);
    tx.update=(ref,...args)=>{if(ref.id==='dispatch-0001') throw new Error('Synthetic migration interruption');return update(ref,...args);};
    return callback(tx);
  });
  try {await assert.rejects(run(apply),/Synthetic migration interruption/);} finally {db.runTransaction=original;}
  assert.equal((await db.collection('_migration_runs').doc('synthetic-run').collection('records').get()).size,1);
  assert.equal((await db.collection('sap_assignments').doc('dispatch-0001').get()).data().lineItems[0].amount,9);
  assert.equal((await run(apply)).changed,2);
  assert.equal((await db.collection('_migration_runs').doc('synthetic-run').collection('records').get()).size,3);
});
test('R30 unresolved customer retains all original data and reports reconciliation',async()=>{
  const before={lineItems:[{...item,customerName:'',truckCompany:'NOT CUSTOMER'}]};
  await db.collection('sap_assignments').doc('unresolved').set(before);
  assert.equal((await run(apply)).unresolved,1);
  assert.deepEqual((await db.collection('sap_assignments').doc('unresolved').get()).data(),before);
  assert.equal((await db.collection('_migration_runs').doc('synthetic-run').collection('records').get()).size,0);
});
test('R29 legacy queue identity converts only with canonical identity proof and known membership/state',async()=>{
  await db.collection('queue').doc('queue-a').set({driverId:'driver-a',status:'loading',assignedShipments:[{dispatchKey:'dispatch-a'}]});
  await db.collection('sap_assignments').doc('dispatch-a').set({driverId:'queue-a',assignedAt:admin.firestore.Timestamp.now()});
  const result=await run(apply,{kind:'driver-uid',lookupIdentity:async uid=>uid==='driver-a'});
  assert.equal(result.changed,1);
  const assignment=(await db.collection('sap_assignments').doc('dispatch-a').get()).data();
  assert.equal(assignment.driverId,'driver-a');assert.equal(assignment.queueId,'queue-a');assert.equal(assignment.tripStatus,'loading');
});
test('R29 ambiguous identity or unproven trip state never guesses an active assignment',async()=>{
  await db.collection('queue').doc('queue-a').set({driverId:'driver-a',status:'completed'});
  await db.collection('sap_assignments').doc('dispatch-a').set({driverId:'queue-a',assignedAt:admin.firestore.Timestamp.now()});
  const result=await run(apply,{kind:'driver-uid',lookupIdentity:async()=>true});
  assert.equal(result.unresolved,1);
  assert.equal((await db.collection('sap_assignments').doc('dispatch-a').get()).data().driverId,'queue-a');
  assert.equal((await db.collection('sap_assignments').doc('dispatch-a').get()).data().tripStatus,undefined);
});
