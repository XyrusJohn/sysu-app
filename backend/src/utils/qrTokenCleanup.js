const cron = require("node-cron");
const {admin} = require("../config/firebase");

const DAY_7_MS = 7 * 24 * 60 * 60 * 1000;

const DB = () => admin.firestore();
const QR_TOKENS = () => DB().collection("qr_tokens");

async function cleanupQRTokens() {
  const now = new Date();

  const [expiredSnap, oldUsedSnap] = await Promise.all([
    QR_TOKENS()
      .where("expiresAt", "<", now)
      .get(),
    QR_TOKENS()
      .where("used", "==", true)
      .where("createdAt", "<", new Date(Date.now() - DAY_7_MS))
      .get(),
  ]);

  const docsToDelete = [
    ...expiredSnap.docs,
    ...oldUsedSnap.docs.filter(
      (d) => !expiredSnap.docs.find((e) => e.id === d.id)
    ),
  ];

  console.log(`[QR Cleanup] Found ${docsToDelete.length} tokens to delete`);
  if (docsToDelete.length === 0) return;

  let deleted = 0;
  for (let i = 0; i < docsToDelete.length; i += 500) {
    const batch = DB().batch();
    docsToDelete.slice(i, i + 500).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += docsToDelete.slice(i, i + 500).length;
    console.log(`[QR Cleanup] Batch committed: ${deleted}/${docsToDelete.length}`);
  }
  console.log(`[QR Cleanup] Done. Deleted ${deleted} tokens.`);
}

function startCleanupScheduler() {
  cron.schedule("0 2 * * *", () => {
    console.log("[QR Cleanup] Starting scheduled cleanup...");
    cleanupQRTokens().catch((err) =>
      console.error("[QR Cleanup] Error:", err.message)
    );
  });
  console.log("[QR Cleanup] Scheduler registered (runs daily 2:00 AM)");
}

async function runCleanupOnce() {
  console.log("[QR Cleanup] Manual run triggered");
  await cleanupQRTokens();
}

module.exports = {startCleanupScheduler, runCleanupOnce};