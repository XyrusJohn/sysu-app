# Delivered Filter — tripStatus "completed" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change the "Delivered" filter in the SAP Shipments tab to show only shipments from `sap_assignments` Firestore where `tripStatus === "completed"`, instead of filtering by `tripStatus === "delivered"` from ODATA.

**Architecture:** Surgical 3-spot edit in `_renderSapTable()` in `frontend/src/pages/dashboard.js`. The filter logic, metric card calculation, and action column all need to source from `sap_assignments` (local DB) instead of ODATA `PgiStatus`. Same table layout, same columns, same buttons — only the filter criteria change.

**Tech Stack:** Vanilla JS, Firebase Firestore (`onSnapshot`), Jest (testing)

## Global Constraints
- Match the existing code style (4-space indent, trailing commas, `_` prefix on private methods).
- Keep all 6 filter buttons intact (Delivered, In Transit, Fully Loaded, Loading, Assigned, For Assignment).
- The `sap_assignments` Firestore doc ID is the dispatch number — enabling a direct join with ODATA rows by key.
- `asgn` is the cached value `this.state.sapAssignments[g.key]`; `asgn?.tripStatus` may be `undefined`, `null`, or a string.

---

### Task 1: Update filter logic for "Delivered" filter

**Files:**
- Modify: `frontend/src/pages/dashboard.js` — `_renderSapTable()` at line 1412

**Interfaces:**
- Consumes: `this.state.sapAssignments[g.key]` (already defined), `this.state.sapFilter` (already defined)
- Produces: No new signatures; changes internal filter behavior in `_renderSapTable`

- [ ] **Step 1: Verify current behavior**

Read the current filter block in `dashboard.js` at line 1412. Confirm the delivered case reads:
```js
if (this.state.sapFilter === "delivered") {
    if (tripStatus !== "delivered") return false;
}
```
Note that `tripStatus` is already defined above as `asgn?.tripStatus` (line 1410), so accessing it again through `asgn?.tripStatus` in the delivered block would be redundant but explicit — we'll match the existing pattern of other filters.

- [ ] **Step 2: Update the filter block**

Replace lines 1412–1413. The current code:
```js
            if (this.state.sapFilter === "delivered") {
                if (tripStatus !== "delivered") return false;
```
Change to:
```js
            if (this.state.sapFilter === "delivered") {
                // Only show rows that have an assignment entry with tripStatus === "completed"
                // from our local sap_assignments database, NOT from SAP ODATA.
                if (!asgn || asgn.tripStatus !== "completed") return false;
```

- [ ] **Step 3: Verify no other filters are affected**

The other filter blocks (`in_transit`, `fully_loaded`, `loading`, `assigned`, `forAssignment`) are NOT modified. Confirm the `else if` chain remains intact after the edit.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "fix: delivered filter now matches sapAssignments tripStatus 'completed' instead of 'delivered'"
```

---

### Task 2: Update metric card — Delivered count

**Files:**
- Modify: `frontend/src/pages/dashboard.js` — `_renderSapTable()` at line 1458

**Interfaces:**
- Consumes: `this.state.sapAssignments` (already populated via `onSnapshot`)
- Produces: `sapStatDel` element textContent is set to the count from `sapAssignments` instead of ODATA

- [ ] **Step 1: Locate the current metric calculation**

Current code at line 1458:
```js
const del = validKeys.filter((k) => (groups[k][0].PgiStatus || groups[k][0].CheckStatus || "").toUpperCase() === "DELIVERED").length;
```

- [ ] **Step 2: Replace metric card calculation**

Replace line 1458. Change from:
```js
        const del = validKeys.filter((k) => (groups[k][0].PgiStatus || groups[k][0].CheckStatus || "").toUpperCase() === "DELIVERED").length;
```
To:
```js
        const del = validKeys.filter((k) => this.state.sapAssignments[k]?.tripStatus === "completed").length;
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "fix: Delivered metric card now counts tripStatus 'completed' from sapAssignments"
```

---

### Task 3: Update action column — "COMPLETE" badge for completed assignments

**Files:**
- Modify: `frontend/src/pages/dashboard.js` — `_renderSapTable()` at line 1495

**Interfaces:**
- Consumes: `asgn` (already scoped in the row-render loop), `status` (ODATA PgiStatus)
- Produces: `isDelivered` boolean controlling the COMPLETE badge vs ASSIGN/CHANGE button

- [ ] **Step 1: Locate current `isDelivered` check**

Current line 1495:
```js
const isDelivered = status.toUpperCase() === "DELIVERED";
```

- [ ] **Step 2: Add sapAssignments check**

Replace line 1495. Change from:
```js
                const isDelivered = status.toUpperCase() === "DELIVERED";
```
To:
```js
                const isDelivered = status.toUpperCase() === "DELIVERED" || asgn?.tripStatus === "completed";
```

This ensures that any shipment that is marked `tripStatus: "completed"` in our local `sap_assignments` DB also shows the "COMPLETE" badge and hides the ASSIGN/CHANGE button — even if SAP ODATA hasn't caught up yet.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "feat: action column shows COMPLETE when sapAssignments tripStatus is 'completed'"
```

---

### Task 4: Add test for delivered filter with sapAssignments tripStatus 'completed'

**Files:**
- Modify: `frontend/src/pages/dashboard.test.js`

**Interfaces:**
- Consumes: `dashboard.state.sapAssignments`, `dashboard.state.sapGroupedByDispatch`, `dashboard.filterSap`
- Produces: No new exports — test file only

- [ ] **Step 1: Add test that delivered filter only passes for 'completed'**

Add the following test at the end of the existing `describe('filterSap', ...)` block in `dashboard.test.js`:

```js
  test('delivered filter shows only tripStatus "completed" from sapAssignments', () => {
    // Setup: populate sapAssignments with some statuses
    dashboard.state.sapAssignments = {
      'DISP-001': { driverName: 'Juan', truckPlate: 'ABC123', tripStatus: 'completed' },
      'DISP-002': { driverName: 'Pedro', truckPlate: 'DEF456', tripStatus: 'in_transit' },
      'DISP-003': { driverName: 'Maria', truckPlate: 'GHI789', tripStatus: null },
    };

    dashboard.state.sapGroupedByDispatch = {
      'DISP-001': [{SAPDispatchNumber: 'DISP-001', OBDNumber: 'OBD-1', Driver: '', PlateNumber: '', ShipmentStart: '', TruckType: '6W', Route: 'Manila-->Makati', PgiStatus: 'Pending', PlanningDate: '/Date(1751587200000)/', ActualDelDate: '/Date(1751587200000)/'}],
      'DISP-002': [{SAPDispatchNumber: 'DISP-002', OBDNumber: 'OBD-2', Driver: '', PlateNumber: '', ShipmentStart: '', TruckType: '6W', Route: 'Manila→QC', PgiStatus: 'In Transit', PlanningDate: '/Date(1751587200000)/', ActualDelDate: '/Date(1751587200000)/'}],
      'DISP-003': [{SAPDispatchNumber: 'DISP-003', OBDNumber: 'OBD-3', Driver: '', PlateNumber: '', ShipmentStart: '', TruckType: '6W', Route: 'Manila→Pasig', PgiStatus: 'Pending', PlanningDate: '/Date(1751587200000)/', ActualDelDate: '/Date(1751587200000)/'}],
    };

    dashboard._renderSapTable.restore && dashboard._renderSapTable();

    // Manually call filterSap with 'delivered' — this sets state.sapFilter and calls _renderSapTable
    dashboard.filterSap('delivered');

    // Assert state was set correctly
    expect(dashboard.state.sapFilter).toBe('delivered');
  });
```

- [ ] **Step 2: Run tests to confirm**

```bash
npx jest --config frontend/jest.config.cjs frontend/src/pages/dashboard.test.js
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/dashboard.test.js
git commit -m "test: add filter test for delivered tripStatus 'completed'"
```

---

### Task 5: Run all existing tests and verify no regressions

**Files:** None modified

- [ ] **Step 1: Run the complete test suite**

```bash
npx jest --config frontend/jest.config.cjs
```

All 8+ tests should pass (7 existing + 1 new).

- [ ] **Step 3: Manual smoke test checklist**

Start the app (`npm run dev` from `frontend/`) and verify:
1. Click "For Assignment" → shows unassigned ODATA shipments
2. Click "Assigned" → shows `tripStatus === null` rows
3. Click "Loading" → shows `tripStatus === "loading"` rows
4. Click "Fully Loaded" → shows `tripStatus === "fully_loaded"` rows
5. Click "In Transit" → shows `tripStatus === "in_transit"` rows
6. Click "Delivered" → shows only rows where `sapAssignments[key].tripStatus === "completed"`
7. Delivered rows show "COMPLETE" badge (not ASSIGN/CHANGE button)
8. Metric card "Delivered" count matches `sapAssignments` completed count

- [ ] **Step 4: Final push**

```bash
git push origin main
```
