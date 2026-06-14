# Confirmed Assignments — SAP-Ready Excel Export + Queue Card Fix

**Date:** 2026-05-29
**Status:** Approved for planning

---

## 1. Problem

The "Confirmed Assignments" Excel export produces columns that differ from what SAP expects.

**Current Excel columns:**
`DISPATCHER NAME | DISPATCHER EMAIL | DISPATCH # | DRIVER NAME | TRUCK TYPE | PLATE # | FORWARDING AGENT`

**Target SAP columns:**
`DISPATCHER NAME | DISPATCH # | DRIVER NAME | TRUCK TYPE | PLATE # | TRUCK COMPANY NAME`

Additionally, `truckCompany` is stored in `queue` but not surfaced in the queue card UI, and is not written to `sap_assignments` at assignment time.

---

## 2. Changes

### 2.1 Write `truckCompany` to `sap_assignments` at assignment time

**Files:** `frontend/src/pages/dashboard.js`

Two functions write to `sap_assignments`:

**`_confirmFleetAssignment()`** — Fleet Manager queue → SAP dispatch (line ~1759)
**`confirmAssignment()`** — SAP table direct assign (line ~2418)

Both currently write:
```js
{ driverId, driverName, truckPlate, assignedAt }
```

Both will additionally write:
```js
{ ..., truckCompany: driver.truckCompany || driver.company || "—" }
```

`driver.truckCompany` comes from the `queue` doc.

### 2.2 Update `exportOrdersExcel()` column format

**File:** `frontend/src/pages/dashboard.js`

**Remove columns:**
- `DISPATCHER EMAIL` — not in SAP target
- `FORWARDING AGENT` — not in SAP target

**Add/keep columns:**
| Column | Source |
|---|---|
| DISPATCHER NAME | `profile.displayName` (unchanged) |
| DISPATCH # | `key` (dispatch number, unchanged) |
| DRIVER NAME | `asgn.driverName` (unchanged) |
| TRUCK TYPE | `rec.TruckType` (unchanged) |
| PLATE # | `asgn.truckPlate` (unchanged) |
| TRUCK COMPANY NAME | `asgn.truckCompany` (new field from `sap_assignments`) |

**Fallback:** If `asgn.truckCompany` is null/empty (old assignments), show `"—"`.

### 2.3 Show `truckCompany` in Fleet Manager queue card

**File:** `frontend/src/pages/dashboard.js`

The queue card (inside `renderFleet()`) currently shows driver name, plate, truck type. Add `truckCompany` as a visible label/badge on the card so it is immediately visible when scanning the queue.

---

## 3. Schema Changes

### `sap_assignments` (new field)
```js
{
  driverId: string,
  driverName: string,
  truckPlate: string,
  truckCompany: string,       // NEW — from queue.truckCompany
  assignedAt: timestamp
}
```

No migration needed. Old docs simply lack `truckCompany` → export shows `"—"`.

### `queue` collection (no schema change — already has `truckCompany`)
```
truckCompany: "Lalamove Philippines Inc"   // already present
```

---

## 4. Backwards Compatibility

- Old `sap_assignments` docs (before this change) do not have `truckCompany`.
- `exportOrdersExcel()` gracefully handles missing field with `"—"` fallback.
- No deletion of any existing data.

---

## 5. Files to Modify

| File | Change |
|---|---|
| `frontend/src/pages/dashboard.js` | `_confirmFleetAssignment()`: add `truckCompany` to `sap_assignments` write |
| `frontend/src/pages/dashboard.js` | `confirmAssignment()`: add `truckCompany` to `sap_assignments` write |
| `frontend/src/pages/dashboard.js` | `exportOrdersExcel()`: replace column layout, add `TRUCK COMPANY NAME` |
| `frontend/src/pages/dashboard.js` | `renderFleet()` queue card: add `truckCompany` display |

No new files. No new dependencies.