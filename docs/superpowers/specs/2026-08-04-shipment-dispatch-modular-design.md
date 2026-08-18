# Shipment Dispatch Modular Design (2026‑08‑04)

## Overview
This design addresses the six feature requests you listed for the SAP shipment tab and driver‑queue workflow. It introduces a **hard‑lock FIFO** assignment model with an auditable override, per‑OBD POD handling, guard‑signature preview, automatic driver completion, and a unified reason dropdown for cancellations/reassignments.

---

## 1. Data Model (Firestore)

| Collection / Document | New fields / structure | Description |
|----------------------|-----------------------|-------------|
| `sap_assignments` (doc per dispatch) | `tripStatus` `string` – one of `null`, `loading`, `fully_loaded`, `in_transit`, `delivered`  
`guardFirstName`, `guardLastName`, `guardMI`, `guardSignatureBase64`, `guardVerified` `boolean`, `guardVerifiedAt` `timestamp`  
`lineItems` `array` – each element now includes optional `podCapturedAt` (`timestamp`) and `podImageUrl` (`string`). | Stores the overall dispatch status, guard‑signature data, and per‑OBD POD data. |
| `queue` (driver‑queue entries) | Existing `status` now also accepts `"complete"`. New fields: `completedAt` `timestamp`, `overrideRequested` `boolean`. | Allows marking a driver as finished and flags when an FIFO override is pending. |
| `driverOverrideRequests` (new) | `driverId`, `dispatchKey`, `reason` (one of the 7 defined reasons), `requestedBy`, `requestedAt`, `approved` `boolean|null`, `approvedBy`, `approvedAt`. | Records every FIFO‑override request for audit. |
| `driverCompletionRequests` (new) | Same schema as above, used for manual or admin‑approved driver‑finished actions. | Enables a consistent approval flow for driver completion. |

> **Indexes** – Composite index on `sap_assignments.tripStatus` + `driverId`; index on `queue.status` + `entryTime` for FIFO sorting.

---

## 2. UI Changes

### SAP Filter Tabs
* Replace the existing six buttons with the **trip‑status** tabs: **Delivered**, **In Transit**, **Fully Loaded**, **Loading**, **Assigned**, and **For Assignment** (unchanged).
* `filterSap(type)` now reads `this.state.sapAssignments[key].tripStatus` (fallback to legacy SAP status if missing).

### Dispatch Detail Modal (`sapDispatchDetail`)
* **Guard Signature Section** – renders the Base64 image, driver name, and a “Verified” badge when `guardVerified` is true.
* **POD Preview** – adds a new column to the OBD line‑items table. Each row shows a 📸 button; clicking opens a light‑box with the POD image (`podImageUrl`) and timestamp (`podCapturedAt`). Visible only when the dispatch’s `tripStatus` is `in_transit` or later.

### Assignment Modal (`assignDriverModal`)
* **Hard‑Lock FIFO** – By default only the earliest queued driver (matching truck type) is enabled. All other rows are greyed out and not clickable.
* **Override FIFO Button** – Appears once per modal. Clicking opens a small overlay:
  * Dropdown of the 7 reasons.
  * “Submit Override” creates a `driverOverrideRequests` document and disables the UI until admin approval.
* **Cancel / Change Driver** – Same dropdown, creates a `driverCompletionRequests` document when the dispatcher is not an admin.
* **Admin Approval Panel** – A new side‑panel (visible to `admin`/`super_admin`) lists pending override and completion requests with **Approve / Reject** actions.

### Driver List (Fleet view)
* New **Finished** column – shows a green badge when `queue.status === "complete"`.
* If a driver has *all* of his shipments in `sap_assignments` with `tripStatus === "delivered"`, a **“Mark as Finished”** button appears, creating an automatic `driverCompletionRequests` that is auto‑approved by the system (see § 5).

---

## 3. Business Logic / Backend

### Trip‑Status Transitions
1. **Guard verification** → `tripStatus = "loading"`.
2. **All PODs uploaded** for a dispatch → `tripStatus = "fully_loaded"`.
3. **Driver starts trip** (e.g., clicks “Start Trip” in the mobile app) → `tripStatus = "in_transit"`.
4. **Driver marks delivered** (or system detects `delivered` from SAP) → `tripStatus = "delivered"`.

Each transition is a simple Firestore `updateDoc` on the relevant `sap_assignments` doc. A small Cloud Function watches `sap_assignments` and, when **all** assignments belonging to a driver have `tripStatus === "delivered"`, it automatically writes a `driverCompletionRequests` doc with `approved = true`. This, in turn, sets the driver’s queue entry `status = "complete"` and records `completedAt`.

### FIFO Hard‑Lock & Override
* `_getAvailableDrivers()` now returns **only the earliest driver** when the UI is in hard‑lock mode. The UI disables the other rows.
* When the dispatcher clicks “Override FIFO”, the client writes a `driverOverrideRequests` doc with the selected reason. The admin panel lists the request; on approval the server sets `overrideRequested = true` on the driver’s queue entry and clears the request. The UI then re‑renders the full driver list, now allowing any driver to be selected.

### Cancel / Reassign Flow
* If the dispatcher is an admin, the request is applied immediately (driver field cleared, `tripStatus` reset to `null`).
* Non‑admin dispatchers create a `driverCompletionRequests` doc. Admin approval removes the driver from the assignment and optionally updates the `tripStatus` back to `null`.
* All actions log the `reason`, `requestedBy`, and timestamps for auditability.

### Security / RBAC
* Existing `protectRoute` middleware is reused.
* Firestore security rules:
  * `driverOverrideRequests` and `driverCompletionRequests` can be read by the creator and admins.
  * Only admins can set `approved = true/false`.
  * Only admins can write to `queue.status = "complete"` directly; otherwise the status change must go through the approved request workflow.

---

## 4. Approval & Audit Trail
All mutable actions (FIFO override, cancel/reassign, driver finish) generate a request document. The admin panel shows:
* Request ID, type, driver, dispatch, reason, requester, request time.
* **Approve** / **Reject** buttons.
* Once approved, a toast notifies the dispatcher and the UI updates automatically.

All request documents retain the full history (approved, rejected, timestamps) for compliance.

---

## 5. Automation – Driver Completion (Option A)
A Cloud Function (`onWrite` trigger for `sap_assignments`) runs the following logic:
```javascript
const driverId = change.after.data().driverId;
const allAssignments = await getDocs(collection(db, "sap_assignments"))
  .where('driverId', '==', driverId)
  .get();
if (allAssignments.docs.every(d => d.data().tripStatus === 'delivered')) {
  // write auto‑approved completion request
  const reqRef = await addDoc(collection(db, 'driverCompletionRequests'), {
    driverId,
    reason: 'All shipments delivered (auto)',
    requestedBy: 'system',
    requestedAt: serverTimestamp(),
    approved: true,
    approvedBy: 'system',
    approvedAt: serverTimestamp()
  });
  // update queue entry
  await updateDoc(doc(db, 'queue', driverId), {
    status: 'complete',
    completedAt: serverTimestamp()
  });
}
```
This satisfies your requirement that **when ALL of a driver’s shipments are delivered, the driver is automatically marked complete**.

---

## 6. Testing Strategy
| Layer | Tests |
|------|-------|
| Unit | Functions that compute the next `tripStatus`; validation of request payloads (reason must be one of the 7). |
| Integration | Firestore security rule enforcement; API endpoints for creating/approving requests; UI FIFO lock behavior; POD preview rendering. |
| E2E (Cypress) | 1. Verify each SAP tab filters correctly based on `tripStatus`.  
2. Attempt to assign a non‑FIFO driver → UI blocks and shows Override button.  
3. Submit an Override request → admin approves → driver list becomes selectable.  
4. Cancel a driver → reason dropdown appears, request appears in admin panel, admin approves, assignment disappears.  
5. POD preview button opens modal with correct image & timestamp.  
6. Guard‑signature preview renders Base64 image and “Verified” badge.  
7. When all shipments for a driver reach `delivered`, driver automatically shows as **Finished**. |
| Performance | Ensure the additional reads on `sap_assignments.tripStatus` keep UI render time < 200 ms on typical data sets (≤ 500 shipments). |

---

## 7. Open Decisions (Confirmed)
* **Driver completion** – **Option A (automatic)** – implemented via Cloud Function.
* **FIFO override** – hard‑lock with admin‑requested override (audit logged).
* **Cancel / Reassign** – uses the same 7‑reason dropdown and requires admin approval.
* **Guard signature** – stored in `sap_assignments` as defined.

---

## 8. Next Steps
1. Commit this spec file.
2. Run a quick **self‑review** (remove any TODO). 
3. Ask you to review the spec.
4. Upon approval, invoke the `writing-plans` skill to generate an implementation plan covering migrations, UI components, backend routes, security rules, and tests.

---

*Spec written and committed on 2026‑08‑04.*
