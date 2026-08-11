// scripts/migrate-sap-assignments-driver-uid.js
// One-time migration: sap_assignments driverId + tripStatus normalization
//
// Responsibilities (run after code deploy of commit 8472e4d + driver-ID unification):
//   1. Rewrite sap_assignments/{dispatchKey}.driverId from queue doc ID → Firebase Auth UID
//      using the queue map: queueDocId → driverId (auth-uid)
//   2. Backfill tripStatus: "assigned" for legacy docs that have assignedAt but no tripStatus
//      (so the Assigned filter includes them after the new write-side change)
//
// Idempotency:
//   - driverId rewrite: only fires if current driverId matches a queue doc ID (not a UID)
//   - tripStatus backfill: only fires if tripStatus is absent (field not present)
//
// After running successfully, delete this file from the repo.

const admin = require("firebase-admin");

// Initialize Firebase Admin. Supports three credential sources (tried in order):
//   1. FIREBASE_SERVICE_ACCOUNT_JSON env var (same format as backend/.env)
//   2. GOOGLE_APPLICATION_CREDENTIALS env var (path to service account JSON file)
//   3. Application Default Credentials (gcloud, GCP machine, etc.)

let credential;
const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (saJson) {
    console.log("Firebase: Loading credentials from FIREBASE_SERVICE_ACCOUNT_JSON");
    let jsonStr = saJson.trim();
    // Repair escaped quotes from copy-paste into .env
    jsonStr = jsonStr.replace(/\\"/g, '"');
    // Repair potential merged strings from .env parsing
    if (jsonStr.includes('}PORT=')) jsonStr = jsonStr.split('PORT=')[0];
    // Remove leading/trailing quotes if present
    if (jsonStr.startsWith('"') || jsonStr.startsWith("'")) jsonStr = jsonStr.substring(1);
    if (jsonStr.endsWith('"') || jsonStr.endsWith("'")) jsonStr = jsonStr.substring(0, jsonStr.length - 1);
    try {
        const serviceAccount = JSON.parse(jsonStr);
        credential = admin.credential.cert(serviceAccount);
    } catch (e) {
        console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:", e.message);
        process.exit(1);
    }
} else {
    console.log("Firebase: Using application default credentials (GOOGLE_APPLICATION_CREDENTIALS or gcloud)");
    credential = admin.credential.applicationDefault();
}

admin.initializeApp({
    credential: credential,
    projectId: process.env.FIREBASE_PROJECT_ID || "sysu-web-5a25d",
});

const DB = () => admin.firestore();
const QUEUE_COLLECTION = "queue";
const ASSIGNMENTS_COLLECTION = "sap_assignments";
const BATCH_SIZE = 500;
const DRY_RUN = process.env.DRY_RUN === "true";

if (DRY_RUN) console.log("[DRY RUN] No writes will be performed.\n");

async function migrate() {
    console.log("========================================");
    console.log("sap_assignments driverId + tripStatus Migration");
    console.log("Phase 1: driverId queue doc ID → Auth UID");
    console.log("Phase 2: backfill tripStatus: 'assigned' for legacy docs");
    console.log("========================================");
    console.log("");

    try {
        // ─── Build queue doc ID → Auth UID map ───────────────────────────────
        const queueSnapshot = await DB().collection(QUEUE_COLLECTION).get();
        const queueToUid = new Map(); // queueDocId → authUid
        const allQueueDocIds = new Set();

        for (const docSnap of queueSnapshot.docs) {
            allQueueDocIds.add(docSnap.id);
            const data = docSnap.data();
            const authUid = data.driverId;
            if (authUid && typeof authUid === "string") {
                queueToUid.set(docSnap.id, authUid);
            }
        }
        console.log(`[Phase 1] Queue map loaded: ${queueToUid.size} entries (${queueSnapshot.size} total queue docs)`);
        console.log("");

        // ─── Walk sap_assignments ──────────────────────────────────────────────
        const assignmentsSnapshot = await DB().collection(ASSIGNMENTS_COLLECTION).get();
        console.log(`[Phase 1+2] sap_assignments total: ${assignmentsSnapshot.size} docs`);
        console.log("");

        if (assignmentsSnapshot.size === 0) {
            console.log("Nothing to migrate. Exiting.");
            process.exit(0);
        }

        let totalDriverIdRewritten = 0;
        let totalDriverIdSkipped = 0;
        let totalTripStatusBackfilled = 0;
        let totalTripStatusSkipped = 0;
        let totalErrors = 0;

        let batch = DB().batch();
        let batchCount = 0;

        for (const docSnap of assignmentsSnapshot.docs) {
            const docRef = docSnap.ref;
            const data = docSnap.data();
            const updates = {};
            const logLines = [];

            // ── Phase 1: driverId rewrite ────────────────────────────────────
            const currentDriverId = data.driverId;
            if (currentDriverId && typeof currentDriverId === "string") {
                if (queueToUid.has(currentDriverId)) {
                    // Current driverId is a queue doc ID — rewrite to UID
                    const newDriverId = queueToUid.get(currentDriverId);
                    if (newDriverId && newDriverId !== currentDriverId) {
                        updates.driverId = newDriverId;
                        logLines.push(`    driverId: ${currentDriverId} → ${newDriverId}`);
                        totalDriverIdRewritten++;
                    } else {
                        totalDriverIdSkipped++;
                    }
                } else if (allQueueDocIds.has(currentDriverId)) {
                    // currentDriverId is a queue doc ID but has no .driverId field — leave alone
                    logLines.push(`    driverId: ${currentDriverId} (queue doc ID but missing .driverId — skipping)`);
                    totalDriverIdSkipped++;
                } else {
                    // currentDriverId is not in queue doc ID set — assume already a UID, skip
                    totalDriverIdSkipped++;
                }
            }

            // ── Phase 2: tripStatus backfill ─────────────────────────────────
            const hasTripStatus = "tripStatus" in data;
            const hasAssignedAt = "assignedAt" in data;
            if (!hasTripStatus && hasAssignedAt) {
                updates.tripStatus = "assigned";
                logLines.push(`    tripStatus: <absent> → "assigned"`);
                totalTripStatusBackfilled++;
            } else {
                totalTripStatusSkipped++;
            }

            // ── Apply changes if any ─────────────────────────────────────────
            if (Object.keys(updates).length === 0) {
                continue;
            }

            if (DRY_RUN) {
                console.log(`  DRY-RUN would update: ${docSnap.id}`);
                logLines.forEach((l) => console.log(l));
            } else {
                batch.update(docRef, updates);
                batchCount++;
                console.log(`  QUEUED: ${docSnap.id}`);
                logLines.forEach((l) => console.log(l));
            }

            // Commit batch when it reaches BATCH_SIZE (only for real runs)
            if (!DRY_RUN && batchCount >= BATCH_SIZE) {
                await batch.commit();
                console.log(`  [Batch committed: ${batchCount} docs]`);
                batch = DB().batch();
                batchCount = 0;
            }
        }

        // Commit remaining docs (only for real runs)
        if (!DRY_RUN && batchCount > 0) {
            await batch.commit();
            console.log(`  [Final batch committed: ${batchCount} docs]`);
        }

        console.log("");
        console.log("========================================");
        if (DRY_RUN) {
            console.log("DRY RUN COMPLETE — no writes were performed");
            console.log("Run without DRY_RUN to execute the migration:");
            console.log("  node scripts/migrate-sap-assignments-driver-uid.js");
        } else {
            console.log("MIGRATION COMPLETE");
            console.log(`driverId rewritten (queue doc ID → Auth UID): ${totalDriverIdRewritten}`);
            console.log(`tripStatus backfilled ("assigned"):            ${totalTripStatusBackfilled}`);
        }
        console.log(`driverId skipped:                              ${totalDriverIdSkipped}`);
        console.log(`tripStatus skipped (already set or no assignedAt): ${totalTripStatusSkipped}`);
        console.log(`Errors:                                        ${totalErrors}`);
        console.log("========================================");
        process.exit(0);

    } catch (error) {
        console.error("Migration FAILED:", error.message);
        process.exit(1);
    }
}

migrate();