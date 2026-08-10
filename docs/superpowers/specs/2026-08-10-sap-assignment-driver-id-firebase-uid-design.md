# SAP Assignment driverId → Firebase Auth UID Design

**Date:** 2026-08-10
**Status:** Approved
**Feature:** Unify driver identifier in `sap_assignments` with Firebase Auth UID
**Related:** [[multiple-shipment-implementation]], SAP Assignment OBD Line Items (2026-05-30), Shipment Dispatch Modular (2026-08-04), Shipment Assignment Cancellation/Change (2026-08-10)

---

## Overview

Change `sap_assignments/{dispatchKey}.driverId` to store the driver's Firebase Auth UID instead of the queue document ID. This unifies the mobile (sysu-go) and web (sysu-app) driver identifiers, allowing both apps to reference drivers using the same canonical key.

---

## Problem Statement

Today, `sap_assignments.driverId` is set to the queue document ID (e.g., `apKuEKdqqD4oJyASqhu9`). However:

1. **Mobile app uses Firebase Auth UID** — sysu-go driver app keys all driver logic on Auth UID (e.g., `pcNEC3JUsJfpNmomLXWVD2E3PkD2`).
2. **Queue doc IDs are not stable driver identifiers** — they are per-registration records. A driver can have multiple queue entries (re-check-ins) without losing their identity.
3. **Cross-app joins are inconsistent** — web app joins `sap_assignments.driverId ↔ queue.id`, but mobile joins `sap_assignments.driverId ↔ users/{uid}`.

This causes:
- Web app can't query "show me all assignments for driver X" using the same key as mobile.
- Migration to newer schemas (e.g., adding `driverUid` field) requires double-write maintenance.
- Audit trails and analytics are split between two identifier systems.

---

## Solution

Make Firebase Auth UID the single canonical driver identifier:

- `sap_assignments/{dispatchKey}.driverId` ← Firebase Auth UID
- `users/{uid}` ← unchanged (canonical user record)
- `queue/{queueDocId}` ← unchanged doc ID, but holds `driverId: <auth-uid>` field for joining
- All web-app lookups join through `queue.find(q => q.driverId === driverId)`

**Why queue doc IDs stay:** A driver can have multiple queue entries (re-check-ins for multiple shipments). Forcing queue doc ID = Auth UID would break the multiple-shipment flow.

---

## Data Model Changes

### Before (current state)

```json
// queue/{queueDocId} — e.g., apKuEKdqqD4oJyASqhu9
{
  "id": "apKuEKdqqD4oJyASqhu9",
  "driverId": "pcNEC3JUsJfpNmomLXWVD2E3PkD2",   // already exists on some docs
  "driverName": "Xyrus John P. Vertucio",
  "plateNumber": "DBS-6564",
  "status": "loading",
  "assignedShipment": "0010133988",
  ...
}

// sap_assignments/{dispatchKey} — e.g., 0010133988
{
  "driverId": "apKuEKdqqD4oJyASqhu9",          // ← queue doc ID (WRONG)
  "driverName": "Xyrus John P. Vertucio",
  "truckPlate": "DBS-6564",
  ...
}
```

### After (target state)

```json
// queue/{queueDocId} — e.g., apKuEKdqqD4oJyASqhu9 (unchanged)
{
  "id": "apKuEKdqqD4oJyASqhu9",
  "driverId": "pcNEC3JUsJfpNmomLXWVD2E3PkD2",   // Auth UID (already populated)
  "driverName": "Xyrus John P. Vertucio",
  ...
}

// sap_assignments/{dispatchKey} — e.g., 0010133988
{
  "driverId": "pcNEC3JUsJfpNmomLXWVD2E3PkD2",   // ← Auth UID (FIXED)
  "driverName": "Xyrus John P. Vertucio",
  "truckPlate": "DBS-6564",
  ...
}
```

**Schema invariants:**
- `sap_assignments/{dispatchKey}.driverId` MUST be a Firebase Auth UID.
- `queue/{queueDocId}.driverId` MUST be a Firebase Auth UID.
- `queue/{queueDocId}.id` (doc ID) is opaque — represents a single registration, not the driver.

---

## Code Changes

### 1. Write Sites (flip to UID)

**File:** `frontend/src/pages/dashboard.js`

**`_confirmFleetAssignment()` (line ~2138):**

Before:
```javascript
const driver = this.state.queue.find((q) => q.id === driverId);
// ...
setDoc(doc(db, "sap_assignments", dispatchKey), {
    driverId,  // ← queue doc ID
    driverName,
    truckPlate,
    ...
});
this._safeUpdateQueueAssignment(driverId, dispatchKey);
```

After:
```javascript
const driver = this.state.queue.find((q) => q.id === driverId);
const driverUid = driver.driverId;  // ← Firebase Auth UID from queue field
if (!driverUid) {
    alert("Cannot assign: queue entry missing driverId (Auth UID). Contact admin.");
    return;
}
// ...
setDoc(doc(db, "sap_assignments", dispatchKey), {
    driverId: driverUid,  // ← Auth UID
    driverName,
    truckPlate,
    ...
});
this._safeUpdateQueueAssignment(driverUid, dispatchKey);
```

**`confirmAssignment()` (line ~3765):** Same flip.

### 2. Read Sites (join through driverId field, not queue id)

All `queue.find(q => q.id === driverId)` → `queue.find(q => q.driverId === driverId)`.

Affected locations in `dashboard.js`:

- **Line ~1956** (`openAssignModalForDriver`): when locating queue entry by queue doc ID, change to lookup by Auth UID if `driverId` parameter is UID.
- **Line ~2103** (`_confirmFleetAssignment`): queue lookup already correct (uses `q.id === driverId` where `driverId` is queue doc ID).
- **Line ~3439–3494** (Order view): `queue.find(q => q.id === dId)` → `queue.find(q => q.driverId === dId)`.
- **Line ~3833** (`_safeUpdateQueueAssignment`): parameter is now Auth UID; update lookup.
- **Line ~2479** (`saveDriver`): unchanged (works with queue doc ID directly).

### 3. Queue Update Helper

**`_safeUpdateQueueAssignment(driverUid, dispatchKey)`:**

Before:
```javascript
async _safeUpdateQueueAssignment(driverId, dispatchKey) {
    const driver = this.state.queue.find(q => q.id === driverId);
    if (driver?.status === "loading") return;
    // updateDoc on queue/{driverId}
}
```

After:
```javascript
async _safeUpdateQueueAssignment(driverUid, dispatchKey) {
    const driver = this.state.queue.find(q => q.driverId === driverUid);
    if (driver?.status === "loading") return;
    // updateDoc on queue/{driver.id} (queue doc ID still needed for the update)
    await updateDoc(doc(db, "queue", driver.id), {
        isAssigned: true,
        status: "loading",
        assignedShipment: dispatchKey,
        updatedAt: serverTimestamp(),
    });
}
```

### 4. Socket/Live Tracking

**`_setupSocket()` (line ~1006):** `liveTracking[data.driverId]` — the socket already sends Auth UID as `driverId` (per sysu-go spec). No change.

**`_setupDriverLocationSocket()` (line ~1102):** Same — `update_admin_map` event sends Auth UID. No change.

---

## Migration (One-Time)

### Goal

Update all existing `sap_assignments/{dispatchKey}` documents where `driverId` is a queue doc ID, replacing it with the corresponding Auth UID from `queue/{queueDocId}.driverId`.

### Script

**File:** `scripts/migrate-sap-assignments-driver-uid.js`

### Algorithm

1. Read all `queue/{queueDocId}` docs into memory.
2. Build map: `queueDocId → driverId (auth-uid)`.
3. For each `sap_assignments` doc:
   - If `driverId` exists in the map (i.e., it's a queue doc ID), `updateDoc` with the resolved UID.
   - If `driverId` doesn't match any queue doc ID, assume it's already a UID — skip (idempotent).
4. Log each rewrite to a migration report.

### Safety

- **Dry-run mode:** print planned changes without writing.
- **Batch writes:** use `Promise.all` with concurrency limit to avoid Firestore rate limits.
- **Backup recommendation:** export `sap_assignments` collection before running.

### Example Output

```
[sap-migration] Queue map size: 47 entries
[sap-migration] sap_assignments total: 312 docs
[sap-migration] To rewrite: 289 docs (queue doc ID → Auth UID)
[sap-migration] Already UID (skipped): 23 docs
[sap-migration] ✅ Migration complete: 289/289 updated
```

---

## Verification

1. **Pre-migration audit:** Count `sap_assignments` docs with `driverId` matching queue doc IDs vs Auth UIDs.
2. **Migration dry-run:** Verify expected rewrite count.
3. **Migration live run:** Execute script, verify completion.
4. **Post-migration spot-check:** Pick 3–5 `sap_assignments` docs, confirm `driverId` resolves to a valid `users/{uid}` doc.
5. **Manual UI test:** Assign a driver from the queue in browser; verify new doc has Auth UID, not queue doc ID.
6. **Multiple-shipment regression:** Assign same driver to 2 dispatches; verify both `sap_assignments` docs share the same `driverId` (UID), and the queue entry's `assignedShipment` list is consistent.
7. **Mobile app sanity:** Have sysu-go team confirm `sap_assignments.driverId` matches their expected Auth UID.

---

## Acceptance Criteria

✅ `sap_assignments/{dispatchKey}.driverId` is always a Firebase Auth UID after migration  
✅ All new writes use Auth UID, not queue doc ID  
✅ Dashboard reads join through `queue.find(q => q.driverId === driverId)`  
✅ One-time migration completes for all legacy docs  
✅ Multiple-shipment flow still works (same UID across multiple assignments)  
✅ Mobile app reads `driverId` as Auth UID without changes  
✅ No regression in fleet view, orders view, or live tracking  

---

## Out of Scope

- Changes to `users/{uid}` collection schema (unchanged).
- Changes to `queue/{queueDocId}` doc IDs (remain opaque registration records).
- Mobile-app changes (sysu-go is a separate repo; this change unifies *toward* their existing assumption).
- New features (e.g., driver analytics, history views) — those can be built on top of this canonical ID later.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Migration corrupts data if queue doc IDs don't have `driverId` field | Pre-migration audit ensures all queue docs have `driverId`; skip and log if missing |
| Web app readers break if migration runs before code deploy | Deploy code FIRST, then run migration (code is backward-compatible via fallback) |
| Mobile app breaks if it depends on queue doc ID format | Verified: mobile already uses Auth UID (per sysu-go spec) |
| Race condition during migration (new writes vs migration) | Run migration during low-traffic window; idempotent design means re-runs are safe |

---

## Open Questions

None — design addresses all specified requirements.

---

*Design committed to: docs/superpowers/specs/2026-08-10-sap-assignment-driver-id-firebase-uid-design.md*