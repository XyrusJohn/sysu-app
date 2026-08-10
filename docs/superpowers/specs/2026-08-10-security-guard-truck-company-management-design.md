# Security Guard & Truck Company Management

**Date:** 2026-08-10
**Status:** Approved
**Feature:** Admin-only CRUD for `security_guard` and `truck_company` collections, surfaced as new sub-tabs inside the Document tab.
**Related:** [Admin Override Approval Flow for FIFO Bypass](2026-08-10-admin-override-approval-fifo-bypass-design.md), [SAP Assignment Driver ID / Firebase UID](2026-08-10-sap-assignment-driver-id-firebase-uid-design.md)

---

## Overview

Add the ability for admins to create, update, and deactivate **security guards** and **truck companies** from the web dashboard. Both collections currently exist as data only (immutable records copied from another system). Promoting them to fully manageable in-app removes the need for direct Firestore edits and lays the groundwork for using these registries as controlled vocabularies in shipment assignment flows.

This is a reference-data management feature, not a workflow feature. The patterns follow the existing admin-only override approval flow and the driver CRUD modal pattern.

---

## Problem Statement

Two pre-existing Firestore collections are written into but never exposed for management:

- **`security_guard`** — used as a lookup for guard signatures on SAP assignment line items (`guardSignatureBase64`). Admins cannot add new guards or rotate them out without touching Firestore directly.
- **`truck_company`** — the registry of trucking companies (e.g., Lalamove, J&T, etc.) that drivers belong to. Today, a new driver can type any company name in the QR-scan flow (`truckCompany` free-text on `queue`). Without a registry, the same company appears under multiple spellings.

Both registries need admin CRUD today and a foundation for normalization tomorrow.

---

## Goal & Non-Goals

### Goal
Provide admins with a full in-app CRUD surface for both collections, gated by role, with auto-incrementing IDs, soft-delete, and live search.

### Non-Goals (this design)
- Mobile-app views of these collections (mobile will read same Firestore data via shared rules).
- Linking these collections to existing `queue.truckCompany` free-text fields (normalization is a separate feature).
- Bulk import/export.
- Adding `updatedAt` audit fields (revisit if regulators ask).
- Hard-deleting records (soft delete is sufficient).

---

## User Experience

### Where the UI lives

Add two new sub-tabs inside the existing **Document** tab (`#docsContent`):

- **Guards** — admin only
- **Truck Companies** — admin only

Existing 5 override-approval sub-tabs (Pending / Approved / Rejected / Expired / Completed) remain unchanged and remain primary. The new sub-tabs sit after Completed and are styled identically.

### Guards sub-tab

```
┌─ Toolbar ────────────────────────────────────────────┐
│ [🔍 Search guards…]                  [➕ Add Guard] │
├──────────────────────────────────────────────────────┤
│ ┌─ SG-001 ─────────────────────────────────────┐    │
│ │ James B. Rivera                  ● Active    │    │
│ │                            [✏ Edit] [⛔ Deact]│    │
│ └──────────────────────────────────────────────┘    │
│ ┌─ SG-002 ─────────────────────────────────────┐    │
│ │ Maria Santos                      ● Inactive │    │
│ │                       [✏ Edit] [↻ Reactivate]│    │
│ └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

Each card shows:
- `guardId` (mono font, badges if needed)
- `fullName` (large text)
- Status pill (active = green; inactive = grey)
- **Edit** button (always visible to admin)
- **Deactivate** when active, **Reactivate** when inactive

Search filters by `guardId`, `firstName`, `lastName`, `fullName` substring (case-insensitive).

### Truck Companies sub-tab

Same layout. Cards show `companyCode`, `name`, `forwarderCode`. Search filters by `companyCode`, `name`, `forwarderCode`.

### Modals

Two modals matching the existing driver modal style (`h-11 bg-db-bg border border-db-border rounded-xl px-4` inputs, `text-[10px] font-bold text-db-text3 uppercase tracking-wider` labels):

```
┌─ Add Guard ────────────────────── × ┐
│                                      │
│  First Name *    [James_________]    │
│  Last Name  *    [Rivera_________]   │
│  Middle Initial  [B.__________]      │
│  ─────────────────────────────────   │
│  Full Name: James B. Rivera          │
│  (auto-generated)                    │
│                                      │
│             [Cancel]    [Save]       │
└──────────────────────────────────────┘
```

The "Full Name" preview is a live computed read-only line that updates as the user types (so admins see what the server will store).

Edit modal is the same form, with the `guardId` shown read-only at the top.

Truck Company modal has just two fields (`Forwarder Code *`, `Name *`) plus the read-only `companyCode` in edit mode.

### Confirmation & feedback

- Soft-delete uses `window.confirm("Deactivate SG-001 James B. Rivera?")`. Matches the driver delete pattern in `dashboard.js:2913-2933`.
- Save success → `showToast("Guard saved", "success")`.
- Validation error → red border on the offending field + inline message + toast on submit.

---

## Data Model

### Collection: `security_guard`

Document ID = `guardId`. One doc per guard.

```typescript
{
  guardId: string,        // Doc ID. Format "SG-NNN", zero-padded to 3 digits.
  firstName: string,      // Required, max 60 chars.
  lastName: string,       // Required, max 60 chars.
  middleInitial: string,  // Optional, max 5 chars (e.g. "B.", "DE", "").
  fullName: string,       // Server-computed: "{firstName} {middleInitial ? middleInitial + ' ' : ''}{lastName}".
  active: boolean,        // true on create.
  createdAt: ISO 8601 UTC string,  // Set by server at create time.
}
```

### Collection: `truck_company`

Document ID = `companyCode`. One doc per company.

```typescript
{
  companyCode: string,    // Doc ID. Format zero-padded number string, e.g. "01", "51".
  forwarderCode: string,  // Required, max 50 chars, alphanumeric.
  name: string,           // Required, max 200 chars.
  active: boolean,        // true on create.
  createdAt: ISO 8601 UTC string,
}
```

### Field invariants

- `guardId` / `companyCode` are immutable once created (no edit endpoint modifies them).
- `fullName` is always recomputed server-side on create and update. The client may preview it but never overrides it.
- `createdAt` is set once at create, never modified.

### Validation rules

Server-side, applied on both create and update. Returns `400` with `{ field, message }` on failure.

- Guard: `firstName` and `lastName` required, ≤ 60 chars after trim. `middleInitial` ≤ 5 chars after trim (may be empty).
- Truck company: `forwarderCode` required, ≤ 50 chars, matches `/^[A-Za-z0-9-]+$/`. `name` required, ≤ 200 chars after trim.

### Soft delete

Soft delete = `updateDoc({ active: false })`. The doc stays in Firestore. No hard delete endpoint.

Reactivation = `updateDoc({ active: true })`. Same endpoint with active flag flipped.

---

## Architecture

### Backend (Node/Express + Firebase Admin SDK)

New controllers under `backend/src/controllers/admin/`:

- `guardController.js`
  - `createGuard(req, res)` — generates `guardId`, validates, writes doc.
  - `updateGuard(req, res)` — updates fields except `guardId`. Recomputes `fullName`.
  - `deactivateGuard(req, res)` — soft delete. Flip `active`.
- `truckCompanyController.js` — mirror of above for `truck_company`.

New route file: `backend/src/routes/adminRoute.js`. Mounts at the existing `/api` prefix:

| Method | Path                                | Purpose                  |
|--------|-------------------------------------|--------------------------|
| POST   | `/api/admin/guards`                 | Create guard             |
| PATCH  | `/api/admin/guards/:id`             | Update guard fields      |
| PATCH  | `/api/admin/guards/:id/active`      | Flip `active` (deactivate/reactivate) |
| POST   | `/api/admin/truck-companies`        | Create truck company     |
| PATCH  | `/api/admin/truck-companies/:code`  | Update truck company     |
| PATCH  | `/api/admin/truck-companies/:code/active` | Flip `active`     |

All routes go through the existing `protectRoute` middleware plus a new local `requireAdmin` middleware that checks `req.user.role in ['admin', 'super_admin']`. Return `403` otherwise.

### ID generation

Both ID generators follow the same pattern, implemented as a module under `backend/src/utils/idGenerator.js`:

```js
generateNextGuardId(): string
  - Run a Firestore transaction
  - Read all docs in security_guard ordered by guardId desc
  - Pick the highest numeric N from existing "SG-NNN" ids
  - If none exist, return "SG-001"
  - Otherwise N + 1, zero-pad to 3 digits
  - Retry once on unexpected race

generateNextCompanyCode(): string
  - Same algorithm but codes are zero-padded numeric strings
  - Min width = 2 digits (matches existing data "01".."51")
```

Re-use of retired IDs: when a guard is deactivated, the ID is NOT freed. New guards always get a fresh ID. This avoids ambiguity when historical records reference the ID.

### Frontend service files

Two new files, matching the existing `OverrideRequestService` pattern (`frontend/src/api/overrideRequestService.js`):

- `frontend/src/api/securityGuardService.js`
  ```js
  SecurityGuardService.subscribe((docs) => { ... }) -> unsubscribe
  SecurityGuardService.create({ firstName, lastName, middleInitial }) -> Promise<{ guardId, ... }>
  SecurityGuardService.update(guardId, { firstName, lastName, middleInitial }) -> Promise
  SecurityGuardService.setActive(guardId, active) -> Promise
  SecurityGuardService.search(query, docs) -> filtered
  ```
- `frontend/src/api/truckCompanyService.js` — mirror.

`create/update/setActive` call backend endpoints via `fetch(${API_CONFIG.BASE_URL}/api/admin/...)`. Reads use `onSnapshot(collection(db, "security_guard"))` directly from Firestore (rules permit authenticated reads).

`AuthService.getToken()` is included as `Authorization: Bearer <idToken>` on every write call, matching the existing `/api/users/update-role` pattern.

### Frontend UI

In `frontend/dashboard.html`:
- Two new sub-tab buttons inside `#docsContent` (Guards, Truck Companies). Hidden when user is not admin via the same data-attribute toggling already used.
- Two new modals near the existing override modals (`#guardModal`, `#truckCompanyModal`).

In `frontend/src/pages/dashboard.js`:
- `_subscribeGuards()` / `_subscribeTruckCompanies()` called from `_startDataEngines()`. Store results in `this.state._guards` and `this.state._truckCompanies`.
- `_renderGuardsView()` and `_renderTruckCompaniesView()` invoked by the existing sub-tab click handler when their tab is selected.
- `openGuardModal(id = null)` / `openTruckCompanyModal(code = null)`.
- `submitGuardForm()` / `submitTruckCompanyForm()` — client-side validation + service call + toast.
- `_softDeleteGuard(guardId, currentlyActive)` / `_softDeleteTruckCompany(code, currentlyActive)` — `confirm()` then service call.

### Sub-tab visibility

Guards and Truck Companies sub-tabs are only rendered when `this._isApprover()` returns true. Non-admin users see only the original 5 override tabs. To keep the existing handler simple, the click handler still iterates all sub-tab buttons; sub-tabs hidden from non-admins just don't exist in the DOM.

---

## Firestore Rules

Add two read-only match blocks in `frontend/firestore.rules`:

```
match /security_guard/{id} {
  allow read: if request.auth != null;
  // Writes blocked — go through backend Admin SDK only.
}
match /truck_company/{id} {
  allow read: if request.auth != null;
  // Writes blocked — go through backend Admin SDK only.
}
```

The default-deny fallback at the bottom of the file remains the safety net for unmatched collections.

---

## Error Handling

- Backend `400` on validation failure → `{ field, message }` → client highlights field + toast.
- Backend `401` / `403` → "You don't have access" toast; client triggers an `AuthService` re-read.
- Backend `409` on ID collision after retry → "Could not generate a unique ID, please retry" toast.
- Backend `5xx` → "Something went wrong, please retry" toast and `console.error` the response body.
- `onSnapshot` error → log to console, render empty list, retain subscription.
- Service methods always return promises; rejections carry the toast-friendly message in `err.message`.

---

## Security

- All write endpoints require a valid Firebase ID token (existing `protectRoute` middleware) and admin/super_admin role.
- ID token is verified by the Firebase Admin SDK; no token forgery possible.
- Backend never trusts `role` from the request body — it always reads from the verified token's user record.
- Reads via Firestore rules require only authentication; this is consistent with `drivers`, `sap_assignments`, etc. The data is not sensitive in itself.
- All write actions are server-side only; direct Firestore writes from the client will fail by default deny.

---

## Trade-offs

- **Reads via `onSnapshot`** (live updates) vs. polling: chose realtime to match the existing override-approval and drivers patterns.
- **Soft delete** vs hard delete: chose soft because the registries are reference data and hard-deletes cascade pain into historical records. Reactivation needs no new code.
- **Live `onSnapshot` reads + server-mediated writes** (hybrid): keeps subscription realtime while enforcing server-side validation and atomic ID generation.
- **Two tabs, two services, two controllers**: explicit duplication (vs a generic "master-data CRUD" abstraction). Chosen because YAGNI and the codebase prefers concrete service files.

---

## Migration / Cutover

- Both collections already exist in production Firestore with the schema above (record count: ~10 guards, ~51 truck companies). No migration needed.
- Adding Firestore rules is a soft cutover — existing data continues to be readable to authenticated users.
- Backend routes ship atomically with the frontend; no partial-deploy risk.
- After deploy, admins immediately see the new sub-tabs; non-admins see no change.

---

## Testing Strategy (deferred to the implementation plan)

- Unit tests for `generateNextGuardId` and `generateNextCompanyCode` (zero, one, many, race collision).
- Service-layer tests for `subscribe` lifecycle and unsubscribe cleanup.
- Backend integration tests for create/update/deactivate with role gating.
- Manual UI check: add a guard, edit, deactivate, reactivate, search.
