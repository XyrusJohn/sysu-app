// scripts/migrate-obd-lineitems.js
// One-time migration: sap_assignments lineItems schema change
// Transforms: {obdNumber, quantity, amount} → {obdNumber, quantity (float), customerName}
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
const COLLECTION = "sap_assignments";
const BATCH_SIZE = 500;
const DRY_RUN = process.env.DRY_RUN === "true";

if (DRY_RUN) console.log("[DRY RUN] No writes will be performed.\n");

async function migrateLineItems() {
    console.log("========================================");
    console.log("sap_assignments lineItems Migration");
    console.log("Target schema: { obdNumber, quantity (float), customerName }");
    console.log("Removing: amount from lineItems");
    console.log("========================================");
    console.log("");

    const collectionRef = DB().collection(COLLECTION);
    let totalDocs = 0;
    let totalMigrated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    try {
        const snapshot = await collectionRef.get();
        totalDocs = snapshot.size;
        console.log(`Found ${totalDocs} documents in ${COLLECTION}`);
        console.log("");

        if (totalDocs === 0) {
            console.log("Nothing to migrate. Exiting.");
            process.exit(0);
        }

        let batch = DB().batch();
        let batchCount = 0;

        for (const docSnap of snapshot.docs) {
            const docRef = docSnap.ref;
            const data = docSnap.data();
            const lineItems = data.lineItems;

            // Skip docs with no lineItems array
            if (!Array.isArray(lineItems) || lineItems.length === 0) {
                totalSkipped++;
                continue;
            }

            // Check if already migrated (has customerName and no amount)
            const first = lineItems[0];
            if (first && typeof first.customerName === "string" && !("amount" in first)) {
                console.log(`  SKIP (already migrated): ${docSnap.id}`);
                totalSkipped++;
                continue;
            }

            // Transform each item in lineItems: remove amount, ensure quantity is float, add customerName
            const newLineItems = lineItems.map((item) => ({
                obdNumber: item.obdNumber || "",
                quantity: parseFloat(item.quantity) || 0,
                customerName: item.customerName || item.truckCompany || "",
            }));

            if (DRY_RUN) {
                console.log(`  DRY-RUN would migrate: ${docSnap.id}`);
                console.log(`    Old lineItems[0]:`, JSON.stringify(lineItems[0]));
                console.log(`    New lineItems[0]:`, JSON.stringify(newLineItems[0]));
            } else {
                batch.update(docRef, { lineItems: newLineItems });
                batchCount++;
                console.log(`  QUEUED: ${docSnap.id}`);
            }

            // Commit batch when it reaches BATCH_SIZE (only for real runs)
            if (!DRY_RUN && batchCount >= BATCH_SIZE) {
                await batch.commit();
                console.log(`  [Batch committed: ${batchCount} docs]`);
                totalMigrated += batchCount;
                batch = DB().batch();
                batchCount = 0;
            }
        }

        // Commit remaining docs (only for real runs)
        if (!DRY_RUN && batchCount > 0) {
            await batch.commit();
            console.log(`  [Final batch committed: ${batchCount} docs]`);
            totalMigrated += batchCount;
        }

        console.log("");
        console.log("========================================");
        if (DRY_RUN) {
            console.log("DRY RUN COMPLETE — no writes were performed");
            console.log("Run without DRY_RUN to execute the migration:");
            console.log("  node scripts/migrate-obd-lineitems.js");
        } else {
            console.log("MIGRATION COMPLETE");
            console.log(`Documents migrated      : ${totalMigrated}`);
        }
        console.log(`Documents skipped         : ${totalSkipped} (empty lineItems or already migrated)`);
        console.log(`Errors                   : ${totalErrors}`);
        console.log("========================================");
        process.exit(0);

    } catch (error) {
        console.error("Migration FAILED:", error.message);
        process.exit(1);
    }
}

migrateLineItems();