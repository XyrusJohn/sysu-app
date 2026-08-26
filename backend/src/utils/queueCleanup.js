const cron = require("node-cron");
const {admin} = require("../config/firebase");

const DAY_30_MS = 30 * 24 * 60 * 60 * 1000;

const DB = () => admin.firestore();
const QUEUE = () => DB().collection("queue");

async function cleanupQueue() {
  const cutoff = new Date(Date.now() - DAY_30_MS);

  const snapshot = await QUEUE()
    .where("status", "in", ["complete", "completed"])
    .where("joinedAt", "<", cutoff)
    .get();

  const docs = snapshot.docs;
  if (docs.length === 0) {
    console.log("[Queue Cleanup] No completed entries older than 30 days");
    return;
  }

  console.log(`[Queue Cleanup] Found ${docs.length} completed entries to delete`);
  let deleted = 0;
  for (let i = 0; i < docs.length; i += 500) {
    const batch = DB().batch();
    docs.slice(i, i + 500).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += docs.slice(i, i + 500).length;
    console.log(`[Queue Cleanup] Batch committed: ${deleted}/${docs.length}`);
  }
  console.log(`[Queue Cleanup] Done. Deleted ${deleted} queue entries.`);
}

function startCleanupScheduler() {
  cron.schedule("0 2 * * *", () => {
    console.log("[Queue Cleanup] Starting scheduled cleanup...");
    cleanupQueue().catch((err) =>
      console.error("[Queue Cleanup] Error:", err.message)
    );
  });
  console.log("[Queue Cleanup] Scheduler registered (runs daily 2:00 AM)");
}

async function runCleanupOnce() {
  console.log("[Queue Cleanup] Manual run triggered");
  await cleanupQueue();
}

module.exports = {startCleanupScheduler, runCleanupOnce};