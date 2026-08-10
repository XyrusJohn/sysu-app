# Strict FIFO Dispatcher Assignment (2026‑08‑11)

## Context

The dispatcher FIFO rule is currently enforced by an `alert()` in the
browser (`frontend/src/pages/dashboard.js`). The actual assignment is written
straight from the client via `setDoc(sap_assignments, …)`. A dispatcher with
DevTools — or anyone reusing an auth token — can pick any driver and bypass
the order entirely. This design closes that hole by moving authoritative
ordering to the backend.

The user described this as: *"the first to get assignment for shipment is the
one who's earliest in the queue, so hindi na madaya ng driver yung system."*

## Threat model

**Threat**: Internal dispatchers bypassing FIFO. We are explicitly NOT focused
on driver-side cheating in this design. Drivers reach the queue through a
gate-check-in flow that is out of scope here.

## Decisions (confirmed in brainstorm)

- Admin-only override authority
- Server-side atomic Firestore transaction for the assignment write
- Lock Firestore writes to a trusted backend path; deny client writes to
  `sap_assignments`, `queue.entryTime`, `queue.status`, `queue.isAssigned`,
  `queue.assignedShipment`
- Hard-locked UI + server-side guard (defense in depth)

## 1. Architecture

### Trust boundary

| Layer                | Trusted?               | Role                                                        |
|----------------------|------------------------|-------------------------------------------------------------|
| Browser (dispatcher) | Not trusted for writes | View + intent only; no direct mutation of protected fields  |
| Backend              | Trusted                | Authoritative writer of `sap_assignments` and queue state   |
| Firestore Rules      | Defense-in-depth       | Belt-and-braces; deny client writes even if backend is down  |
| Admin approval flow  | Trusted                | Source of override tokens                                   |

### Components

1. **`POST /api/sap/assign`** — runs the authoritative assignment transaction.
2. **`POST /api/sap/overrides`** — dispatcher requests a bypass; admin approves
   or denies; on approval a single-use, short-lived `overrideToken` is issued.
3. **`GET /api/sap/peek`** — server returns `{ earliestDriverId, queueSnapshot }`
   for the modal to render correctly without trusting client ordering.
4. **`firestore.rules`** — deny client writes to protected paths.
5. **Frontend modal** — hard-locked rows + "Request admin bypass" flow; never
   writes `sap_assignments` directly.

## 2. Data flow

### Happy path (FIFO honored)

1. Dispatcher opens the Assign Driver modal.
2. Frontend calls `GET /api/sap/peek?dispatchKey=X&truckType=Y`.
3. Server returns `{ earliestDriverId, queueSnapshot }`.
4. Modal renders: only earliest driver row is enabled; others are greyed with
   a tooltip naming the earliest driver.
5. Dispatcher confirms. Frontend calls `POST /api/sap/assign` with
   `{ dispatchKey, requestedDriverId }`.
6. Backend runs a Firestore transaction:
   - Read dispatch — must be unassigned.
   - Read queue entries matching truck type.
   - Sort by `entryTime` ASC; reject if `requestedDriverId !== earliest.id`.
   - Write `sap_assignments/{dispatchKey}` with `{ driverId, driverName, truckPlate, truckCompany, assignedAt, assignedBy, overrideTokenId? }`.
   - Update `queue/{requestedDriverId}` to `{ status: "loading", isAssigned: true, assignedShipment: dispatchKey, updatedAt }`.
   - Commit.

### Bypass path

1. Dispatcher clicks "Request admin bypass".
2. Modal opens a reason dropdown (allowed reasons set is defined in code; same
   set as prior override specs).
3. Frontend writes `overrideRequests/{id}` with `{ dispatchKey, requestedDriverId, reason, requestedBy, requestedAt, status: "pending" }`.
4. Modal shows live status: "Awaiting admin approval for {driverName}…".
   Subscribe to `overrideRequests/{id}` for state changes.
5. Admin sees this in the approval panel (real-time `onSnapshot`).
6. Admin approves → backend issues `overrideTokens/{tokenId}`:
   `{ dispatchKey, requestedDriverId, issuedBy, issuedAt, expiresAt (issuedAt + 15m), consumedAt: null, requestId }`.
   Writes `overrideRequests/{id}` `{ status: "approved", decidedBy, decidedAt }`.
7. Dispatcher modal sees approval → unlocks the chosen driver row.
8. Dispatcher confirms → `POST /api/sap/assign` with
   `{ dispatchKey, requestedDriverId, overrideTokenId }`.
9. Backend transaction: validates token (exists, unconsumed, unexpired, dispatch
   matches, driver matches) → performs the same writes and sets `consumedAt`.
10. `overrideRequests/{id}` is marked `status: "consumed"`.

### Race resolution

Two dispatchers tap assign on the same dispatch within milliseconds:
- Firestore transaction is the serialization point.
- First commits, second re-reads inside its transaction and sees the assignment
  already exists / queue entry already `loading`. Returns `409 DISPATCH_TAKEN`.

## 3. Errors and UX states

Codes returned by `POST /api/sap/assign`:

| Code               | HTTP | Trigger                                         | UX                                |
|--------------------|------|-------------------------------------------------|-----------------------------------|
| `NOT_EARLIEST`     | 409  | Non-earliest driver, no token                   | Banner: "{name} is next in line." |
| `TOKEN_REQUIRED`   | 403  | Non-earliest driver, no token                   | Same; highlight "Request bypass"  |
| `TOKEN_EXPIRED`    | 410  | Token > 15 min old                              | "Bypass expired — request new."   |
| `TOKEN_CONSUMED`   | 409  | Token already used                              | "This bypass was already used."   |
| `TOKEN_MISMATCH`   | 403  | Token ≠ requested driver / dispatch             | "Bypass doesn't apply here."      |
| `DRIVER_INACTIVE`  | 409  | Driver left queue or status=complete            | "Driver no longer in queue."      |
| `DISPATCH_TAKEN`   | 409  | Another dispatcher won the race                 | Toast + modal closes, list refreshes |
| `VALIDATION`       | 400  | Missing/invalid fields                          | Inline field errors               |

All errors structured:
```json
{ "success": false, "code": "NOT_EARLIEST", "message": "...", "meta": { "earliestDriverId": "..." } }
```

Edge states:

- No drivers in queue → "No drivers available." Confirm disabled.
- All drivers complete → "All drivers finished their shift." Confirm disabled.
- No drivers of the required truck type → "No {truckType} drivers queued."
- Override pending → modal pulses "Awaiting admin approval… requested {N}s ago." Cancel button revokes the request.
- Override denied → banner "Bypass denied by {adminName}." Dispatcher can request again.

## 4. Audit

Every `overrideTokens/{tokenId}` carries: `issuedBy`, `issuedAt`, `expiresAt`,
`consumedAt?`, `consumedBy?`, `dispatchKey`, `requestedDriverId`, `reason`,
`requestId`.

Every `overrideRequests/{id}` carries: full lifecycle (`pending` → `approved`
| `denied` → `consumed` | `expired` | `revoked`), `requestedBy`,
`requestedAt`, `requestedReason`, `decidedBy?`, `decidedAt?`, `decision?`.

Every `sap_assignments/{dispatchKey}` keeps `assignedAt`, `assignedBy`, and
`overrideTokenId?`. Clients cannot write — the audit trail is honest because
the write path is one.

## 5. Files and boundaries

### Backend

- `backend/src/controllers/sapAssignmentController.js` (new)
  - `peekEarliest`, `assignDriver`, `requestOverride`, `issueOverrideToken` (admin),
    `decideOverride` (admin), `revokeOverride`.
- `backend/src/routes/sapAssignmentRoute.js` (new)
- `backend/src/services/queueOrdering.js` (new, pure)
  - `resolveEarliest(entries, requiredTruckType)` → `{ earliest, alternates }`.
  - No Firestore imports; easy to unit-test.
- `backend/src/services/tokenService.js` (new)
  - `issue`, `verify`, `consume`, `revoke`. TTL config; single-use.
- `firestore.rules` (updated)
  - `sap_assignments`: deny client writes; allow backend + admin reads.
  - `queue.entryTime`, `queue.status`, `queue.isAssigned`,
    `queue.assignedShipment`: deny client writes.
  - `overrideTokens`: deny client reads and writes; backend service only.
  - `overrideRequests`: dispatcher may create `pending` for their own `requestedBy`;
    admin may update decision fields; no client may directly create `approved`.

### Frontend

- `frontend/src/api/sapAssignmentService.js` (new)
  - `peekEarliest(dispatchKey, truckType)`
  - `assignDriver(dispatchKey, driverId, overrideTokenId?)`
  - `requestOverride({ dispatchKey, driverId, reason })`
  - `cancelOverride(requestId)`
  - `subscribeOverrideRequest(requestId, cb)`
- `frontend/src/pages/dashboard.js`
  - `confirmAssignment` rewritten to call the service; no direct Firestore writes.
  - `_renderAssignDriverModal` rebuilt: greyed rows, "Request bypass" button,
    banner for error codes.
  - Remove the existing client-side FIFO `alert()` (superseded).
- `frontend/src/api/overrideRequestService.js`
  - Add admin decision methods (approve / deny), already partially exists.

## 6. Testing strategy

### Unit (backend)

- `resolveEarliest` with fixtures: empty queue, mixed truck types, ties on
  `entryTime` (deterministic by doc id).
- Token validity: expired, consumed, mismatched dispatch, mismatched driver.
- Reason validation: must be in allowed set.

### Integration

- Two concurrent assigns on the same dispatch → exactly one `200`, one `409
  DISPATCH_TAKEN`.
- Override happy path: admin issues token → dispatcher uses → second use fails
  with `TOKEN_CONSUMED`.
- Expired token returns `410`.
- Direct Firestore write from a client SDK with dispatcher credentials is
  denied by rules.
- Dispatcher cannot mutate `queue.entryTime` from client SDK.

### Frontend

- Modal: earliest row enabled, others disabled with tooltip naming the
  earliest driver.
- Bypass flow: requesting, awaiting, approved, denied, expired.
- Each error code surfaces the right banner.
- When `DISPATCH_TAKEN`, modal closes automatically and the assignment list
  refreshes.

### E2E / manual

- DevTools-bypass attempt: dispatcher disables the UI guard and calls the
  endpoint with a non-earliest driver → server returns `NOT_EARLIEST`.
- Admin denies bypass → dispatcher request moves to "denied"; modal
  recovers cleanly.
- Happy path: dispatcher opens modal, sees earliest driver only, confirms,
  assignment is visible.

## 7. Out of scope

- Driver-side anti-cheating (gate check-in tampering, backdated driver
  `entryTime`).
- Mobile driver status updates.
- Queue cleanup / driver completion logic.

## 8. Next steps

1. Commit this spec to `docs/superpowers/specs/`. *(Writing it now per the
   user override of the brainstorming hard-gate; the spec is the in-chat
   design captured for the record.)*
2. Replace the client-side `setDoc(sap_assignments, …)` with the new
   service call as the first commit. *(Smallest change that kills the
   dispatcher-cheating surface; shippable on its own.)*
3. Build the backend route, token service, queue ordering helper, and
   Firestore rules update.
4. Add unit + integration tests for the transaction and token paths.
5. Wire the admin approval UI to consume tokens.
