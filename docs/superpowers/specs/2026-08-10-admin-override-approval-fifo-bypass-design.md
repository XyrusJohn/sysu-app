# Admin Override Approval Flow for FIFO Bypass

**Date:** 2026-08-10
**Status:** Approved
**Feature:** Admin-gated override for FIFO-first shipment assignment
**Related:** [[sap-assignment-driver-id-firebase-uid]], SAP Assignment OBD Line Items (2026-05-30), Shipment Dispatch Modular (2026-08-04), Shipment Assignment Cancellation/Change (2026-08-10)

---

## Overview

Add an audited, admin-gated override path so dispatchers can bypass the strict FIFO enforcement in special cases (VIP customer, urgent delivery, driver request, etc.) without weakening the default FIFO ordering. Pair the workflow with a visual highlight that makes the FIFO-first driver obvious in the Assign Driver modal — protecting FIFO visually while still leaving an escape hatch when business needs demand it.

---

## Problem Statement

FIFO is now strict across both the **Queue** and **Assigned** tabs in the Assign Driver modal (recent fix). When a dispatcher selects any driver other than the FIFO-first, assignment is blocked.

That is correct for the default case, but it leaves no escape hatch for legitimate edge cases:
- A VIP customer needs an urgent pickup and the dispatcher must assign a specific driver regardless of queue position.
- A driver who is going off-shift soon requests the next shipment so they can finish before end-of-day.
- A specific truck type match is required that the FIFO-first driver cannot fulfil.

Today the dispatcher has no recourse. They either:
- Pick the wrong driver and fail at write time, or
- Wait until the FIFO-first driver is ready (potentially hours), or
- Bypass via out-of-band communication with admin (no audit trail).

We need an in-app flow with:
- A documented reason
- Admin approval
- Real-time status visible to both parties
- Full audit trail (who, what, when)
- Visual cue so FIFO ordering is still the obvious default

---

## Solution

Introduce a new Firestore collection `override_requests` that captures each bypass attempt as a discrete, audited document. The dispatcher initiates, the admin approves or rejects, and on approval the dispatcher can complete the assignment via a manual Proceed action — preserving the dispatcher agency that the manual-proceed step was chosen to keep.

Pair the workflow with a visual highlight: the FIFO-first driver gets a bright gold pulsing border + `FIFO-NEXT` badge in the modal. This makes FIFO ordering the obvious default and signals why a non-FIFO selection is a deviation, not a normal flow.

---

## Data Model

### Collection: `override_requests`

Each request is one document with an auto-generated Firestore ID. Flat collection — no nesting inside `sap_assignments`.

### Schema

```typescript
{
  // ─── Identity ───────────────────────────────────────
  dispatchKey: string,             // e.g., "0010133987"
  requestedDriverId: string,       // Auth UID of driver to assign
  requestedDriverName: string,     // denormalized for display
  requestedDriverPlate: string,    // denormalized for display
  fifoFirstDriverId: string,       // Auth UID of FIFO-first driver (the bypassed one)
  fifoFirstDriverName: string,     // denormalized for display

  // ─── Reason ─────────────────────────────────────────
  reason: "vip_customer" | "driver_request" | "urgent_delivery" | "truck_match" | "other",
  note: string | null,             // free-text only when reason === "other"

  // ─── State ──────────────────────────────────────────
  status: "pending" | "approved" | "rejected" | "expired" | "completed",

  // ─── Audit trail ────────────────────────────────────
  submittedBy: string,             // Auth UID of dispatcher
  submittedByName: string,         // denormalized
  submittedAt: Timestamp,

  approvedBy: string | null,       // Auth UID of admin
  approvedByName: string | null,
  approvedAt: Timestamp | null,
  expiresAt: Timestamp | null,     // approvedAt + 1h

  rejectedBy: string | null,
  rejectedByName: string | null,
  rejectedAt: Timestamp | null,

  completedAt: Timestamp | null,   // set when dispatcher clicks Proceed and assignment writes
}
```

### Indexes

| Fields | Purpose |
|--------|---------|
| `status` ASC, `submittedAt` DESC | Admin "Pending" tab — sorted oldest first to handle FIFO fairly |
| `submittedBy` ASC, `submittedAt` DESC | Dispatcher "My Requests" view |
| `dispatchKey` ASC, `status` ASC | Detect existing pending request for a shipment |

### Lifecycle

```
   submit                approve                proceed (within 1h)
pending ────────► approved ───────────────► completed
   │                  │
   │                  └─► expired  (1h elapsed, dispatcher did not Proceed)
   │
   └────► rejected  (admin rejects)
```

---

## Reason Dropdown

Stored as constants on the dashboard class:

| Value | Label | Optional note? |
|-------|-------|---------------|
| `vip_customer` | VIP Customer — Urgent Delivery | No |
| `driver_request` | Driver Personal Request | No |
| `urgent_delivery` | Time-Critical Delivery | No |
| `truck_match` | Specific Truck Requirement | No |
| `other` | Other | Yes (free-text, max 200 chars) |

When `other` is selected, a textarea appears for additional context. The `note` field is stored alongside the enum.

---

## User Flows

### Dispatcher flow

1. Dispatcher clicks **Assign** on a shipment in the SAP Shipments table.
2. Assign Driver modal opens.
3. **FIFO-first driver is highlighted**: bright gold border + soft pulsing glow + `FIFO-NEXT` badge with star icon. All other drivers render as before.
4. Dispatcher selects a non-FIFO-first driver. Clicks **Confirm**.
5. Strict FIFO check blocks the assignment with an alert:
   > "Assignment blocked: [FIFO-first name] is the earliest available driver. To bypass, request admin approval."
6. The Confirm button is re-enabled, and a secondary **Request Override** button appears below it.
7. Dispatcher clicks **Request Override**. A sub-modal opens with the reason dropdown (and optional note when "Other" is selected).
8. Dispatcher submits. New doc in `override_requests` is created with `status: "pending"`.
9. Modal closes. Dispatcher sees a toast: "Override request submitted. Track status in Documents tab."
10. If dispatcher re-opens the Assign modal for the same shipment while the request is pending, a yellow banner at top reads: *"A request is pending admin approval for this shipment. Cannot submit another."* Request Override button is disabled.

### Admin flow

1. Admin opens the **Documents** tab in the sidebar.
2. Documents tab renders a single list of override requests with status sub-tabs: **Pending** / **Approved** / **Rejected** / **Expired** / **Completed**.
3. **Pending** tab is the default. Lists requests sorted oldest-first. Each row shows:
   - Shipment (dispatchKey)
   - Requested driver (name, plate)
   - FIFO-first driver bypassed (name, plate)
   - Reason (with note if `other`)
   - Submitted by + at
4. Each pending row has **Approve** and **Reject** buttons.
5. Admin clicks **Approve**:
   - Doc updates to `status: "approved"`, `approvedAt`, `approvedBy`, `expiresAt = approvedAt + 1h`.
   - Optional confirmation: "Approve override for shipment [dispatchKey]? Requested driver: [name]. FIFO-first: [name]."
6. Admin clicks **Reject**:
   - Doc updates to `status: "rejected"`, `rejectedAt`, `rejectedBy`.

### Post-approval dispatcher flow

1. Dispatcher opens the **Documents** tab and switches to the **Approved** sub-tab.
2. Approved requests are visible. Each row has a **Proceed** button if `expiresAt > now`, else disabled with **Expired** label.
3. Dispatcher clicks **Proceed**. Modal opens pre-filled:
   - Shipment: dispatchKey (read-only)
   - Driver: requested driver (read-only)
   - Note: "Override approved by [admin name] at [timestamp]"
   - **Confirm** button (no FIFO check applies — bypass is granted by the approved request)
4. Dispatcher confirms. Existing `_confirmFleetAssignment()` write path runs as normal, writing to `sap_assignments/{dispatchKey}` with `driverId = requestedDriverId`, `tripStatus: "assigned"`, etc.
5. Request doc updates to `status: "completed"`, `completedAt`.
6. Toast: "Shipment [dispatchKey] assigned to [driver name] via approved override."

### Expiry sweep

When the dispatcher loads the Approved tab, the renderer checks each approved request against `now`. If `expiresAt <= now`, the renderer dispatches a background update to set `status: "expired"`. No Cloud Function needed for the initial implementation — the sweep runs lazily on tab load.

---

## Architecture

### New methods on `Dashboard` class

```javascript
// ─── Override request lifecycle ───────────────────────
async _submitOverrideRequest(reason, note)            // dispatcher submit
async _approveOverrideRequest(requestId)              // admin approve
async _rejectOverrideRequest(requestId)               // admin reject
async _markOverrideCompleted(requestId)               // dispatcher proceed → completed
async _sweepExpiredRequests()                         // lazy expiry on Documents tab load

// ─── Helpers ──────────────────────────────────────────
_getPendingRequestForShipment(dispatchKey)             // local cache check
_subscribeOverrideRequests()                           // onSnapshot listener
_renderDocsView()                                     // Documents tab render
_renderOverrideRequestList(filter)                    // sub-list by status
_isApprover()                                         // role check
_handleProceedApprovedOverride(requestId)             // dispatcher Proceed button

// ─── Visual ───────────────────────────────────────────
_highlightFifoFirst(driverRows, fifoFirstId)           // adds CSS class + badge to row
```

### Data flow

```
[Dispatcher Assign modal]
   ↓ click Request Override → submit
[Firestore: override_requests/{newId}, status=pending]
   │
   ├── onSnapshot ──► [All dashboards subscribed]
   │                    ↓
   │             [Documents tab renders pending list]
   │                    ↓
   │             [Admin clicks Approve]
   │                    ↓
   │             [Firestore: status=approved, expiresAt=+1h]
   │                    ↓
   │             [Dispatcher Documents tab → Approved]
   │                    ↓
   │             [Click Proceed → opens pre-filled modal]
   │                    ↓
   │             [Confirm → _confirmFleetAssignment()]
   │                    ↓
   │             [Firestore: sap_assignments/{dispatchKey} ← driverId]
   │                    ↓
   │             [Firestore: override_requests/{id} → completed]
```

### FIFO-first visual highlight

Add CSS class `fifo-next` on the row whose `id === firstInQueue.id`:

```css
.driver-row.fifo-next {
    border: 2px solid var(--color-sysu-gold);
    box-shadow: 0 0 0 4px rgba(245, 166, 35, 0.25);
    animation: fifo-pulse 2s ease-in-out infinite;
}

@keyframes fifo-pulse {
    0%, 100% { box-shadow: 0 0 0 4px rgba(245, 166, 35, 0.25); }
    50%      { box-shadow: 0 0 0 8px rgba(245, 166, 35, 0.40); }
}

.fifo-next-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    background: var(--color-sysu-gold);
    color: #000;
    border-radius: 9999px;
    font-size: 9px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-left: 8px;
}
```

The badge appears next to the driver name in the FIFO-first row only.

### Pending-request blocking

In `openAssignModal`, query `override_requests` filtered by `dispatchKey + status=pending`. If found:
- Render a yellow banner at top: *"A request is pending admin approval for this shipment."*
- Disable the **Request Override** button (it would still show but greyed out, with the banner explaining why).
- Driver rows remain selectable (dispatcher may want to back out and pick FIFO-first instead).

---

## Security & Authorization

- **Frontend gate**: Approve / Reject buttons are only rendered when `_isApprover()` returns true, where approver = `role === "admin" || role === "super_admin"`.
- **Backend**: Firestore security rules are **out of scope** for this spec. The current rules permit authenticated reads/writes; tightening them is a separate ops task. For now, the frontend check is the only enforcement layer.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Submit fails (network) | Toast: "Failed to submit request. Retry." Retry button. |
| Approve fails (network) | Toast: "Failed to approve. Retry." Button stays enabled. |
| Approve fails because already-rejected | Toast: "Request was already rejected. Refresh to see latest." |
| Proceed fails (Firestore write error) | Existing `_confirmFleetAssignment` error handling applies. Request stays `approved`. |
| Race: dispatcher submits while admin rejects | Last write wins on individual fields. Both writes succeed; status reflects whichever happened last. No data corruption. |
| Listener disconnect | Dashboard's existing reconnect logic applies; `onSnapshot` resumes on reconnect. |
| Request expired between Documents tab load and Proceed click | Proceed button shows "Expired" disabled. No write. |

---

## Testing

### Manual end-to-end (Vite dev server)

1. Open dashboard. Navigate to SAP Shipments tab.
2. Click **Assign** on any unassigned shipment.
3. Verify FIFO-first driver has gold border + pulse + `FIFO-NEXT` badge.
4. Click any non-FIFO-first driver. Click Confirm.
5. Verify alert blocks the assignment.
6. Click **Request Override**. Select reason `vip_customer`. Submit.
7. Verify toast "Override request submitted."
8. Open **Documents** tab. Verify the request appears in **Pending** sub-tab with correct fields.
9. As admin (separate browser session or sign in as admin), open Documents tab. Click **Approve**.
10. Back as dispatcher: refresh Documents → **Approved** sub-tab. Verify Proceed button is enabled.
11. Click **Proceed**. Verify modal opens pre-filled with the right shipment + driver. Confirm.
12. Verify:
    - `sap_assignments/{dispatchKey}` now has `driverId = requestedDriverId`, `tripStatus: "assigned"`.
    - `override_requests/{id}` has `status: "completed"`, `completedAt` set.
    - The shipment moves out of "For Assignment" and into "Assigned" filter in the SAP table.

### Edge cases

| Case | Expected |
|------|----------|
| Submit request, then try to submit another for same shipment | Second submit blocked; "Request Pending" banner shown. |
| Approve, then wait 1 hour, then click Proceed | Proceed button disabled, "Expired" label. |
| Reject request | Request moves to Rejected tab. No Proceed button. |
| Try to Approve as dispatcher (non-admin) | Approve / Reject buttons not rendered at all (frontend role check). |
| Approve then close dispatcher session, reopen later, navigate to Documents | Approved request still visible if within 1h of approval. |
| `other` reason selected with empty note | Allow submit. Note is null/empty. Reason stored. |

---

## Acceptance Criteria

- Dispatcher cannot bypass FIFO without going through the override flow.
- All override requests are recorded in `override_requests` with full audit trail.
- Admin can approve or reject any pending request.
- Approved request grants exactly one Proceed action for the specific (shipment, driver) pair.
- Approved request expires 1 hour after approval.
- Expired / rejected / completed requests are clearly distinguished in the Documents tab.
- FIFO-first driver is visually highlighted whenever the Assign modal opens.
- Concurrent requests for the same shipment are blocked.

---

## Out of Scope

- Firestore security rules update (separate ops task).
- Email / SMS notifications on approve or reject.
- Bulk approve / multi-select.
- Cloud Function for proactive expiry sweep (current lazy sweep is sufficient).
- Audit log export (data is already in `override_requests`; export script can come later).
- Mobile-app equivalent (sysu-go remains unaffected).

---

## Open Questions

None — all clarified during brainstorming.

---

*Spec committed to: docs/superpowers/specs/2026-08-10-admin-override-approval-fifo-bypass-design.md*
