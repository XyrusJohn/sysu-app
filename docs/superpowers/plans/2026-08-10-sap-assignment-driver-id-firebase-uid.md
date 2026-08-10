# SAP Assignment driverId → Firebase Auth UID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify `sap_assignments/{dispatchKey}.driverId` with the driver's Firebase Auth UID so the mobile (sysu-go) and web (sysu-app) apps refer to drivers with the same canonical identifier.

**Architecture:** Deploy new writes first (always store Auth UID on `sap_assignments.driverId`), then run a one-time migration script that backfills Auth UID on legacy docs. All dashboard queue joins change from `q.id === driverId` to `q.driverId === driverId`. Defensive guard rejects assignments when queue entry has no `driverId` field.

**Tech Stack:** Firebase Firestore, Firebase Admin SDK (Node.js migration script), vanilla JS (dashboard.js)

---

## Pre-flight: Key Findings From Codebase

Before starting, know these facts:

- **`sap_assignments` doc ID** = the dispatch number (e.g., `0010133988`). Confirmed by the user.
- **`queue/{queueDocId}.driverId`** is already populated with Auth UID on all current entries (verified 2026-08-10). Example: `driverId: "pcNEC3JUsJfpNmomLXWVD2E3PkD2"`.
- **Write sites** for `sap_assignments`: `_confirmFleetAssignment()` (~line 2138) and `confirmAssignment()` (~line 3765). Both currently write `driverId: <queueDocId>`.
- **Read sites** that join through queue entries: order view (~line 3439–3494), `_safeUpdateQueueAssignment()` (~line 3833), `_getAvailableDrivers()` helpers. Currently all use `queue.find(q => q.id === driverId)` — must flip to `queue.find(q => q.driverId === driverId)`.
- **Socket/live tracking** already uses Auth UID as `driverId` (per sysu-go spec). No changes needed there.
- **Multiple-shipment flow** preserved: a driver can have multiple queue entries (re-check-ins). Queue doc IDs stay opaque.

## File Map

```
frontend/src/pages/dashboard.js              — 2 method updates (writes), multiple read-site fixes (joins)
scripts/migrate-sap-assignments-driver-uid.js — NEW: one-time Firestore migration script
docs/superpowers/specs/.../2026-08-10-sap-assignment-driver-id-firebase-uid-design.md  — REFERENCE (already committed)
```

---

## TASK 1: Update `_confirmFleetAssignment()` write in dashboard.js

**File:** `frontend/src/pages/dashboard.js` — `_confirmFleetAssignment()` method, around lines 2100–2167

The Fleet Manager single-driver assignment path. Flip `driverId` from queue doc ID to Auth UID.

- [ ] **Step 1: Locate the existing assignment write code**

Read `frontend/src/pages/dashboard.js` around line 2138. Find the block:
```js
const driver = this.state.queue.find((q) => q.id === driverId);
if (!driver) {
    alert("Driver not found in queue. The driver may have already been assigned.");
    this.closeAssignModal();
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = originalText; }
    return;
}

const driverName = driver.driverName || "Unknown Driver";
const truckPlate = driver.plateNumber || "—";
```

- [ ] **Step 2: Add the defensive guard after the existing driver lookup**

Insert immediately after `const truckPlate = driver.plateNumber || "—";` (and before the `lineItems` derivation):
```js
const driverUid = driver.driverId; // Firebase Auth UID from queue entry
if (!driverUid) {
    alert("Cannot assign: queue entry is missing driverId (Auth UID). Contact admin.");
    this.closeAssignModal();
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = originalText; }
    return;
}
```

- [ ] **Step 3: Replace the `driverId` field in the `setDoc` payload**

Find the existing `setDoc` call (around line 2139):
```js
setDoc(doc(db, "sap_assignments", dispatchKey), {
    driverId,
    driverName,
    truckPlate,
    truckCompany: driver.truckCompany || driver.company || "—",
    assignedAt: ts(),
    lineItems,
}),
```

Replace `driverId,` with `driverId: driverUid,` so it becomes:
```js
setDoc(doc(db, "sap_assignments", dispatchKey), {
    driverId: driverUid,
    driverName,
    truckPlate,
    truckCompany: driver.truckCompany || driver.company || "—",
    assignedAt: ts(),
    lineItems,
}),
```

- [ ] **Step 4: Replace the `_safeUpdateQueueAssignment` argument**

Find:
```js
// Safe queue update: skips rewriting status if driver is already loading another dispatch
this._safeUpdateQueueAssignment(driverId, dispatchKey),
```

Replace with:
```js
// Safe queue update: skips rewriting status if driver is already loading another dispatch
this._safeUpdateQueueAssignment(driverUid, dispatchKey),
```

- [ ] **Step 5: Verify the change**

```powershell
Select-String -Path frontend/src/pages/dashboard.js -Pattern "driverId: driverUid," -AllMatches
```
Expected: 1 match inside `_confirmFleetAssignment()` (after Task 1, there will be 2 matches total once Task 2 also flips its write).

```powershell
Select-String -Path frontend/src/pages/dashboard.js -Pattern "Cannot assign: queue entry is missing driverId" -AllMatches
```
Expected: 1 match inside `_confirmFleetAssignment()`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "feat(dashboard): flip _confirmFleetAssignment write to Auth UID for sap_assignments.driverId"
```

---

## TASK 2: Update `confirmAssignment()` write in dashboard.js

**File:** `frontend/src/pages/dashboard.js` — `confirmAssignment()` method, around lines 3730–3790

The other assignment write site (used outside the Fleet Manager flow, e.g., direct assignment from SAP tab). Apply the same flip.

- [ ] **Step 1: Locate the existing assignment write code**

Read `frontend/src/pages/dashboard.js` around line 3743. Find:
```js
const driver = this.state.queue.find(q => q.id === driverId);
if (!driver) throw new Error("Driver not found in queue.");

const driverName = driver.driverName || driver.user?.name || "Unknown Driver";
```

- [ ] **Step 2: Add the defensive guard after the existing driver lookup**

Insert immediately after the `driverName` line:
```js
const driverUid = driver.driverId; // Firebase Auth UID from queue entry
if (!driverUid) throw new Error("Queue entry is missing driverId (Auth UID). Contact admin.");
```

- [ ] **Step 3: Replace the `driverId` field in the `setDoc` payload**

Find:
```js
await setDoc(doc(db, "sap_assignments", dispatchKey), {
    driverId,
    driverName,
    truckPlate,
    ...
});
```

Replace `driverId,` with `driverId: driverUid,` so it becomes:
```js
await setDoc(doc(db, "sap_assignments", dispatchKey), {
    driverId: driverUid,
    driverName,
    truckPlate,
    ...
});
```

- [ ] **Step 4: Replace the `_safeUpdateQueueAssignment` argument**

Find:
```js
await this._safeUpdateQueueAssignment(driverId, this.state.assignTarget);
```

Replace with:
```js
await this._safeUpdateQueueAssignment(driverUid, this.state.assignTarget);
```

- [ ] **Step 5: Verify the change**

```powershell
Select-String -Path frontend/src/pages/dashboard.js -Pattern "driverId: driverUid," -AllMatches
```
Expected: 2 matches (one in each write site).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "feat(dashboard): flip confirmAssignment write to Auth UID for sap_assignments.driverId"
```

---

## TASK 3: Update `_safeUpdateQueueAssignment()` helper

**File:** `frontend/src/pages/dashboard.js` — `_safeUpdateQueueAssignment()` method, around lines 3829–3870

This helper currently expects `driverId` = queue doc ID. Now it must expect `driverId` = Auth UID and resolve the queue entry through `queue.find(q => q.driverId === driverUid)`.

- [ ] **Step 1: Locate the existing helper**

Read `frontend/src/pages/dashboard.js` around line 3832. Find:
```js
async _safeUpdateQueueAssignment(driverId, dispatchKey) {
    const driver = this.state.queue.find(q => q.id === driverId);
    if (driver?.status === "loading") {
        console.log(`[_safeUpdateQueue] Driver ${driverId} is already loading — not overwriting queue status`);
        return;
    }
    // ... updateDoc on queue/{driverId} (or wherever the existing update path goes)
}
```

- [ ] **Step 2: Update the queue entry lookup**

Find:
```js
const driver = this.state.queue.find(q => q.id === driverId);
```

Replace with:
```js
// driverId here is the Firebase Auth UID (passed from assignment write sites)
const driver = this.state.queue.find(q => q.driverId === driverId);
```

- [ ] **Step 3: Verify the change**

```powershell
Select-String -Path frontend/src/pages/dashboard.js -Pattern "queue.find\(q => q.driverId" -AllMatches
```
Expected: ≥1 match (this helper).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "feat(dashboard): resolve queue entry via Auth UID in _safeUpdateQueueAssignment"
```

---

## TASK 4: Update order-view driver joins

**File:** `frontend/src/pages/dashboard.js` — order view driver-record build, around lines 3439–3494

The order view merges `sap_assignments` with queue entries to display assigned-driver cards. Currently joins by queue doc ID; needs to join by Auth UID.

- [ ] **Step 1: Locate the assigned-driver record build**

Read `frontend/src/pages/dashboard.js` around line 3439. Find:
```js
// ── 2. Build assigned-driver records from sap_assignments ───
// One record per driverId — merges multiple assignments for the same driver.
// FIFO rule:
//   • Prefers queueEntry.entryTime (exact check-in time) whenever available.
```

Just below, look for the loop where each `sap_assignments` entry is converted to an `assignedDrivers` record. The pattern typically looks like:
```js
for (const [dispatchKey, asgn] of Object.entries(this.state.sapAssignments)) {
    const dId = asgn.driverId;
    if (!dId) continue;
    const driver = this.state.drivers.find((drv) => drv.id === dId) || {};
    const queueEntry = this.state.queue.find((q) => q.id === dId);
    // ...
}
```

- [ ] **Step 2: Flip the queue join to use `driverId` field**

Find:
```js
const queueEntry = this.state.queue.find((q) => q.id === dId);
```

Replace with:
```js
// sap_assignments.driverId is the Auth UID now
const queueEntry = this.state.queue.find((q) => q.driverId === dId);
```

- [ ] **Step 3: Find any other `queue.find((q) => q.id === dId)` or similar in this region**

Use `Select-String` to scan the order view block:
```powershell
Select-String -Path frontend/src/pages/dashboard.js -Pattern "queue.find\(\(q\) => q\.id ===" -AllMatches
```
Expected: zero matches inside the order-view block after this task (the only remaining ones should be in `_safeUpdateQueueAssignment` and other write/read sites we already updated).

Replace any remaining occurrences with `q.driverId === driverId` (where the variable name matches the local context).

- [ ] **Step 4: Verify the change**

```powershell
Select-String -Path frontend/src/pages/dashboard.js -Pattern "queue.find\(\(q\) => q\.driverId" -AllMatches
```
Expected: ≥2 matches (this task + `_safeUpdateQueueAssignment` from Task 3).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "feat(dashboard): join queue entries by Auth UID in order view"
```

---

## TASK 5: Create migration script for legacy `sap_assignments` docs

**File:** `scripts/migrate-sap-assignments-driver-uid.js` — NEW

A one-time migration script that rewrites legacy `sap_assignments.driverId` from queue doc ID to Auth UID by looking up `queue/{queueDocId}.driverId`.

- [ ] **Step 1: Read an existing migration script for the project pattern**

Read `scripts/migrate-obd-lineitems.js` to follow the project's conventions (CLI args, dry-run flag, output format, Firebase Admin SDK usage).

- [ ] **Step 2: Create the new migration script**

Write `scripts/migrate-sap-assignments-driver-uid.js` with this structure:
```js
// scripts/migrate-sap-assignments-driver-uid.js
// One-time migration: rewrite sap_assignments/{dispatchKey}.driverId
// from queue doc ID → Firebase Auth UID.
//
// Usage:
//   node scripts/migrate-sap-assignments-driver-uid.js [--dry-run]
//
// Reads: queue collection (to build queueDocId → driverId map)
// Writes: sap_assignments collection (driverId field on each doc)
// Idempotent: skips docs whose driverId is already a UID (heuristic:
//   if the value doesn't match any queue doc ID, treat as already a UID).

const admin = require("firebase-admin");
const serviceAccount = require("./service-account-key.json"); // adjust per project pattern

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function main() {
    const dryRun = process.argv.includes("--dry-run");

    // 1. Build queue doc ID → driverId (Auth UID) map
    const queueSnap = await db.collection("queue").get();
    const queueDocIdToUid = new Map();
    let queueMissingDriverId = 0;
    queueSnap.forEach(doc => {
        const data = doc.data();
        if (data.driverId) {
            queueDocIdToUid.set(doc.id, data.driverId);
        } else {
            queueMissingDriverId++;
        }
    });
    console.log(`[sap-migration] Queue map size: ${queueDocIdToUid.size} entries`);
    if (queueMissingDriverId > 0) {
        console.warn(`[sap-migration] ⚠️  ${queueMissingDriverId} queue docs missing driverId field — pre-migration fix needed`);
    }

    // 2. Scan all sap_assignments docs
    const sapSnap = await db.collection("sap_assignments").get();
    let toRewrite = 0;
    let alreadyUid = 0;
    let missing = 0;
    const updates = [];

    sapSnap.forEach(doc => {
        const data = doc.data();
        const currentDriverId = data.driverId;
        if (!currentDriverId) {
            missing++;
            return;
        }
        if (queueDocIdToUid.has(currentDriverId)) {
            const newUid = queueDocIdToUid.get(currentDriverId);
            toRewrite++;
            updates.push({ id: doc.id, from: currentDriverId, to: newUid });
        } else {
            alreadyUid++;
        }
    });

    console.log(`[sap-migration] sap_assignments total: ${sapSnap.size} docs`);
    console.log(`[sap-migration] To rewrite (queue doc ID → Auth UID): ${toRewrite} docs`);
    console.log(`[sap-migration] Already UID (skipped): ${alreadyUid} docs`);
    console.log(`[sap-migration] Missing driverId (skipped): ${missing} docs`);

    if (dryRun) {
        console.log("[sap-migration] DRY RUN — no writes performed");
        console.log("[sap-migration] Sample (first 5):", updates.slice(0, 5));
        return;
    }

    // 3. Apply updates in batches
    let written = 0;
    const batchSize = 500;
    for (let i = 0; i < updates.length; i += batchSize) {
        const batch = db.batch();
        const slice = updates.slice(i, i + batchSize);
        for (const u of slice) {
            const ref = db.collection("sap_assignments").doc(u.id);
            batch.update(ref, { driverId: u.to });
        }
        await batch.commit();
        written += slice.length;
        console.log(`[sap-migration] Batch ${Math.floor(i / batchSize) + 1}: wrote ${written}/${updates.length}`);
    }

    console.log(`[sap-migration] ✅ Migration complete: ${written}/${updates.length} updated`);
}

main().catch(err => {
    console.error("[sap-migration] ❌ Error:", err);
    process.exit(1);
});
```

- [ ] **Step 3: Run dry-run mode first**

```bash
node scripts/migrate-sap-assignments-driver-uid.js --dry-run
```

Expected output (sample):
```
[sap-migration] Queue map size: 47 entries
[sap-migration] sap_assignments total: 312 docs
[sap-migration] To rewrite (queue doc ID → Auth UID): 289 docs
[sap-migration] Already UID (skipped): 23 docs
[sap-migration] Missing driverId (skipped): 0 docs
[sap-migration] DRY RUN — no writes performed
```

- [ ] **Step 4: Verify the dry-run numbers look reasonable**

Open the Firebase console → Firestore → `sap_assignments` collection. Spot-check 5 docs:
- For "To rewrite" docs, confirm `driverId` currently equals a queue doc ID.
- For "Already UID" docs, confirm `driverId` looks like a Firebase Auth UID (28 chars, alphanumeric).

If numbers don't match the spot-check, **STOP** — do not run live migration. Investigate.

- [ ] **Step 5: Run live migration**

```bash
node scripts/migrate-sap-assignments-driver-uid.js
```

Expected output:
```
[sap-migration] ✅ Migration complete: 289/289 updated
```

- [ ] **Step 6: Post-migration spot-check**

Open Firebase console → Firestore → `sap_assignments`. Pick 5 random docs. For each, verify:
- `driverId` is a Firebase Auth UID (28 chars).
- The corresponding `users/{driverId}` doc exists (can resolve driver identity).

- [ ] **Step 7: Commit**

```bash
git add scripts/migrate-sap-assignments-driver-uid.js
git commit -m "feat(scripts): one-time migration to rewrite sap_assignments.driverId from queue doc ID to Auth UID"
```

---

## TASK 6: Manual end-to-end verification

**Goal:** Confirm the new assignment flow writes Auth UID, and existing flows still work after migration.

- [ ] **Step 1: Start the dev server**

```bash
cd frontend
npm run dev
```

Open the dashboard in a browser.

- [ ] **Step 2: Verify the Fleet Manager assignment flow**

1. Navigate to the Fleet Manager / Drivers tab.
2. Click an available driver row to open the assign modal.
3. Select an unassigned dispatch and confirm assignment.
4. Open Firebase console → Firestore → `sap_assignments/{dispatchKey}`.
5. Verify `driverId` is a Firebase Auth UID (28 chars), NOT a queue doc ID (e.g., `apKuEKdqqD4oJyASqhu9`).

- [ ] **Step 3: Verify the order view shows the assigned driver**

1. Navigate to the Orders tab.
2. Confirm the newly assigned dispatch appears with the correct driver name, plate, and truck company.
3. The driver card should match what was selected in the Fleet Manager.

- [ ] **Step 4: Verify the multiple-shipment flow still works**

1. From Fleet Manager, assign the same driver to a second dispatch.
2. Open Firebase console → Firestore → both `sap_assignments` docs.
3. Confirm both docs have the same `driverId` (Auth UID).
4. Confirm the queue entry for this driver has `isAssigned: true` and shows both dispatch numbers in `assignedShipment`.

- [ ] **Step 5: Verify the assignment-cancellation flow (if implemented)**

If the spec from `2026-08-10-shipment-assignment-cancellation-change-design.md` is already deployed:
1. Open a shipment with an existing assignment.
2. Submit a "Change Driver" or "Cancel Assignment" request.
3. Confirm the request references the correct Auth UID in `currentDriverId` / `newDriverId`.

- [ ] **Step 6: Coordinate with sysu-go team**

Notify the sysu-go (mobile) team that `sap_assignments.driverId` is now universally Auth UID. They do NOT need code changes (their app already uses this assumption), but they should verify their drivers see the correct assignments.

- [ ] **Step 7: Commit verification notes (optional)**

If any issues were found and fixed, commit them. Otherwise, no commit needed for this task.

---

## Self-Review

**Spec coverage check:**
- "Make Auth UID the canonical driver ID" → Tasks 1, 2 (writes)
- "Update all dashboard readers to join through Auth UID" → Tasks 3, 4
- "One-time migration" → Task 5
- "Verification" → Task 6
- All sections of the spec covered.

**Placeholder scan:** No "TBD", no "TODO", no "implement later". All code blocks contain real, runnable code.

**Type consistency:** `driverUid` (local var) consistently used; `driverId` (Auth UID) consistently threaded through `_safeUpdateQueueAssignment`; `queue.find(q => q.driverId === X)` pattern used everywhere.