# Delivered Filter — tripStatus "completed" (2026-08-05)

## Overview
Change the "Delivered" filter in the SAP Shipments tab to show only shipments from our local `sap_assignments` Firestore collection where `tripStatus === "completed"`, instead of filtering by `tripStatus === "delivered"` from ODATA.

## Architecture
**Files modified:**
- `frontend/src/pages/dashboard.js` — `_renderSapTable()` filter block, metric card calculation, action column
- `frontend/dashboard.html` — no structural changes; button labels and layout unchanged
- `frontend/src/api/sapService.js` — no changes

**No new files, no new components.** Pure filter logic change.

## Data Flow

All six filter buttons share the same SAP ODATA table, but filter criteria differ:

| Filter | Data Source | Filter Logic |
|--------|------------|--------------|
| For Assignment | ODATA only | No `sapAssignments` entry + `isUnassignable` + `Delivery !== "DELIVERED"` |
| Assigned | ODATA + sapAssignments | `tripStatus === null` |
| Loading | ODATA + sapAssignments | `tripStatus === "loading"` |
| Fully Loaded | ODATA + sapAssignments | `tripStatus === "fully_loaded"` |
| In Transit | ODATA + sapAssignments | `tripStatus === "in_transit"` |
| Delivered | ODATA + sapAssignments | `tripStatus === "completed"` (CHANGED from `=== "delivered"`) |

The `sapAssignments` doc ID is the dispatch number, enabling a direct join with ODATA rows.

## Code Changes

### 1. Filter logic (`_renderSapTable()`, ~line 1412)

```javascript
// BEFORE
if (this.state.sapFilter === "delivered") {
    if (tripStatus !== "delivered") return false;
}

// AFTER
if (this.state.sapFilter === "delivered") {
    const asgn = this.state.sapAssignments[g.key];
    if (!asgn || asgn.tripStatus !== "completed") return false;
}
```

### 2. Metric card — Delivered count (`_renderSapTable()`, ~line 1458)

```javascript
// BEFORE:
const del = validKeys.filter((k) =>
    (groups[k][0].PgiStatus || groups[k][0].CheckStatus || "").toUpperCase() === "DELIVERED"
).length;

// AFTER:
const del = validKeys.filter((k) =>
    this.state.sapAssignments[k]?.tripStatus === "completed"
).length;
```

### 3. Action column — "COMPLETE" badge (`_renderSapTable()`, ~line 1495)

```javascript
// BEFORE:
const isDelivered = status.toUpperCase() === "DELIVERED";

// AFTER:
const isDelivered =
    status.toUpperCase() === "DELIVERED" ||
    asgn?.tripStatus === "completed";
```

## Edge Cases
- `sapAssignments` empty/loading → filters show 0 results (expected)
- `tripStatus` undefined/missing → filtered out by `!== "completed"` comparison
- Real-time updates → Firestore `onSnapshot` auto-updates `sapAssignments`, table re-renders
- Delivered shipments won't appear in "For Assignment" (they have an assignment entry)
- Metric card `sapStatDel` now counts from `sapAssignments.tripStatus` not ODATA `PgiStatus`

## Testing
- [ ] "For Assignment" filter still shows unassigned ODATA shipments
- [ ] "Assigned" filter shows `tripStatus === null` rows
- [ ] "Loading" filter shows `tripStatus === "loading"` rows
- [ ] "Fully Loaded" filter shows `tripStatus === "fully_loaded"` rows
- [ ] "In Transit" filter shows `tripStatus === "in_transit"` rows
- [ ] "Delivered" filter shows only `tripStatus === "completed"` rows, no unassigned ODATA
- [ ] Delivered rows show "COMPLETE" badge in action column
- [ ] Metric card Delivered count matches `sapAssignments` completed count
- [ ] Text search works across all filters
- [ ] Column sorting works across all filters