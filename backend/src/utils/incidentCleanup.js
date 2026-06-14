const cron = require("node-cron");
const {admin} = require("../config/firebase");

const DAY_60_MS = 60 * 24 * 60 * 60 * 1000;

const DB = () => admin.firestore();
const INCIDENTS = () => DB().collection("incidents");

async function cleanupIncidents() {
  const cutoff = new Date(Date.now() - DAY_60_MS);

  const snapshot = await INCIDENTS()
    .where("createdAt", "<", cutoff)
    .get();

  const docs = snapshot.docs;
  if (docs.length === 0) {
    console.log("[Incidents Cleanup] No incidents older than 60 days");
    return;
  }

  console.log(`[Incidents Cleanup] Found ${docs.length} incidents to delete`);
  let deleted = 0;
  for (let i = 0; i < docs.length; i += 500) {
    const batch = DB().batch();
    docs.slice(i, i + 500).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += docs.slice(i, i + 500).length;
    console.log(`[Incidents Cleanup] Batch committed: ${deleted}/${docs.length}`);
  }
  console.log(`[Incidents Cleanup] Done. Deleted ${deleted} incidents.`);
}

function startCleanupScheduler() {
  cron.schedule("0 2 * * *", () => {
    console.log("[Incidents Cleanup] Starting scheduled cleanup...");
    cleanupIncidents().catch((err) =>
      console.error("[Incidents Cleanup] Error:", err.message)
    );
  });
  console.log("[Incidents Cleanup] Scheduler registered (runs daily 2:00 AM)");
}

async function runCleanupOnce() {
  console.log("[Incidents Cleanup] Manual run triggered");
  await cleanupIncidents();
}

module.exports = {startCleanupScheduler, runCleanupOnce};