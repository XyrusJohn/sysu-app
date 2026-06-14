# Confirmed Assignments — SAP Excel Export + truckCompany Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add `truckCompany` to `sap_assignments` writes (both assignment flows), update Excel export columns to match SAP format, and surface `truckCompany` in the Fleet Manager queue card.

**Architecture:** Single-file change in `frontend/src/pages/dashboard.js`. No new dependencies. Backwards-compatible — old `sap_assignments` docs without `truckCompany` fall back to `"—"` in exports.

**Tech Stack:** Vanilla JS, Firebase Firestore, xlsx library (existing).

---

## File Map

| Location | Role |
|---|---|
| `frontend/src/pages/dashboard.js:1759` | `_confirmFleetAssignment()` — writes `sap_assignments` |
| `frontend/src/pages/dashboard.js:2418` | `confirmAssignment()` — writes `sap_assignments` |
| `frontend/src/pages/dashboard.js:2803–2806` | `exportOrdersExcel()` — `COL_KEYS` array |
| `frontend/src/pages/dashboard.js:2834` | `exportOrdersExcel()` — `COL_WIDTHS` array |
| `frontend/src/pages/dashboard.js:2765–2775` | `exportOrdersExcel()` — first row builder (no SAP record) |
| `frontend/src/pages/dashboard.js:2784–2794` | `exportOrdersExcel()` — second row builder (per SAP record) |
| `frontend/src/pages/dashboard.js:1528–1533` | `renderFleet()` queue card — driver info section |

---

## Task 1: Add `truckCompany` to `_confirmFleetAssignment()` sap_assignments write

**File:** `frontend/src/pages/dashboard.js:1759`

> The `driver` variable is available via `this.state.queue.find(q => q.id === driverId)` at line 1745. No additional lookups needed.

- [ ] **Step 1: Verify current setDoc block**

Lines 1759–1764 currently read:
```js
setDoc(doc(db, "sap_assignments", dispatchKey), {
    driverId,
    driverName,
    truckPlate,
    assignedAt: ts(),
}),
```

- [ ] **Step 2: Edit line 1759–1764 to add `truckCompany`**

Replace the `setDoc(...)` object with:
```js
setDoc(doc(db, "sap_assignments", dispatchKey), {
    driverId,
    driverName,
    truckPlate,
    truckCompany: driver.truckCompany || driver.company || "—",
    assignedAt: ts(),
}),
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "feat(fleet): write truckCompany to sap_assignments on fleet manager assignment

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Add `truckCompany` to `confirmAssignment()` sap_assignments write

**File:** `frontend/src/pages/dashboard.js:2418`

> Same driver source — `this.state.queue.find(q => q.id === driverId)` already resolves the full `queue` doc with `truckCompany`.

- [ ] **Step 1: Verify current setDoc block**

Lines 2418–2423 currently read:
```js
await setDoc(doc(db, "sap_assignments", dispatchKey), {
    driverId,
    driverName,
    truckPlate,
    assignedAt: serverTimestamp(),
});
```

- [ ] **Step 2: Edit lines 2418–2423 to add `truckCompany`**

Replace with:
```js
await setDoc(doc(db, "sap_assignments", dispatchKey), {
    driverId,
    driverName,
    truckPlate,
    truckCompany: driver.truckCompany || driver.company || "—",
    assignedAt: serverTimestamp(),
});
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "feat(assign): write truckCompany to sap_assignments on direct SAP assignment

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Update `exportOrdersExcel()` column layout

**File:** `frontend/src/pages/dashboard.js:2803–2834` and `frontend/src/pages/dashboard.js:2765–2795`

> Old `sap_assignments` docs have no `truckCompany`. The `|| "—"` fallback handles them gracefully.

- [ ] **Step 1: Update `COL_KEYS` — remove DISPATCHER EMAIL and FORWARDING AGENT, add TRUCK COMPANY NAME**

Lines 2803–2806:
```js
const COL_KEYS = [
    "DISPATCHER NAME", "DISPATCHER EMAIL", "DISPATCH #", "DRIVER NAME",
    "TRUCK TYPE", "PLATE #", "FORWARDING AGENT",
];
```
Change to:
```js
const COL_KEYS = [
    "DISPATCHER NAME", "DISPATCH #", "DRIVER NAME",
    "TRUCK TYPE", "PLATE #", "TRUCK COMPANY NAME",
];
```

- [ ] **Step 2: Update `COL_WIDTHS` to 6 columns**

Line 2834:
```js
const COL_WIDTHS = [24, 28, 14, 22, 14, 14, 20];
```
Change to:
```js
const COL_WIDTHS = [24, 14, 22, 14, 14, 20];
```

- [ ] **Step 3: Update first row builder (fallback branch — no SAP record found)**

Around line 2765. Currently:
```js
rows.push({
    "DISPATCHER NAME": dispatcherName,
    "DISPATCHER EMAIL": dispatcherEmail,
    "DISPATCH #": key.replace(/^0+/, "") || key,
    "DRIVER NAME": asgn.driverName || "—",
    "TRUCK TYPE": "—",
    "PLATE #": asgn.truckPlate || "—",
    "FORWARDING AGENT": "—",
});
```
Change to:
```js
rows.push({
    "DISPATCHER NAME": dispatcherName,
    "DISPATCH #": key.replace(/^0+/, "") || key,
    "DRIVER NAME": asgn.driverName || "—",
    "TRUCK TYPE": "—",
    "PLATE #": asgn.truckPlate || "—",
    "TRUCK COMPANY NAME": asgn.truckCompany || "—",
});
```

- [ ] **Step 4: Update second row builder (SAP records loop)**

Around line 2784. Currently:
```js
const row = {
    "DISPATCHER NAME": dispatcherName,
    "DISPATCHER EMAIL": dispatcherEmail,
    "DISPATCH #": key.replace(/^0+/, "") || key,
    "DRIVER NAME": asgn.driverName || "—",
    "TRUCK TYPE": rec.TruckType || "—",
    "PLATE #": asgn.truckPlate || "—",
    "FORWARDING AGENT": rec.ForwardingAgent || "—",
};
```
Change to:
```js
const row = {
    "DISPATCHER NAME": dispatcherName,
    "DISPATCH #": key.replace(/^0+/, "") || key,
    "DRIVER NAME": asgn.driverName || "—",
    "TRUCK TYPE": rec.TruckType || "—",
    "PLATE #": asgn.truckPlate || "—",
    "TRUCK COMPANY NAME": asgn.truckCompany || "—",
};
```

- [ ] **Step 5: Verify no remaining references to removed column keys**

Run: `grep -n "DISPATCHER EMAIL\|FORWARDING AGENT" frontend/src/pages/dashboard.js`
Expected: no matches after Steps 1–4 complete.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "feat(orders): update Excel export to SAP column format + add TRUCK COMPANY NAME

- Remove DISPATCHER EMAIL and FORWARDING AGENT columns
- Add TRUCK COMPANY NAME from sap_assignments.truckCompany
- Update COL_KEYS, COL_WIDTHS, and all row builders

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Show `truckCompany` on Fleet Manager queue cards

**File:** `frontend/src/pages/dashboard.js:1528–1533` (inside `renderFleet()` map callback)

> The `d` object in the map callback is a queue doc. `d.truckCompany` is already populated by the mobile app on check-in.

- [ ] **Step 1: Find the driver info block inside the queue card HTML**

Look for the block around lines 1528–1533 that contains:
```html
<div class="text-[12px] font-bold text-db-text truncate">${escapeHtml(d.driverName || "—")}</div>
<div class="text-[9px] font-mono text-db-text3 opacity-60">${escapeHtml(d.plateNumber || "—")}</div>
```

This is inside the template literal starting around line 1509.

- [ ] **Step 2: Add truckCompany badge after the plate number line**

After:
```js
<div class="text-[9px] font-mono text-db-text3 opacity-60">${escapeHtml(d.plateNumber || "—")}</div>
```
Insert:
```js
${d.truckCompany ? `<div class="text-[9px] font-medium mt-0.5 truncate" style="color:#d4a017cc;">${escapeHtml(d.truckCompany)}</div>` : ""}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "feat(fleet): show truckCompany on Fleet Manager queue card

Makes the driver's trucking company visible at a glance when
scanning the queue, reducing lookup time before assignment.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Spec Coverage Checklist

- [x] `_confirmFleetAssignment()` writes `truckCompany` → **Task 1**
- [x] `confirmAssignment()` writes `truckCompany` → **Task 2**
- [x] `exportOrdersExcel()` column layout updated → **Task 3**
- [x] Queue card shows `truckCompany` → **Task 4**
- [x] No schema migration needed → handled by `"—"` fallback
- [x] No references to removed columns remain → `grep` verification in Task 3

---

## Clarification (2026-05-30)

**`truckCompany` (driver's trucking company) is a document-level field on `sap_assignments` — it is NOT inside `lineItems` and is NOT affected by the OBD lineItems schema change.**

The OBD lineItems schema change (2026-05-30) only affects the `lineItems[]` array:
- REMOVED from `lineItems`: `amount`
- ADDED to `lineItems`: `customerName` (delivery recipient / ship-to party)
- CHANGED in `lineItems`: `quantity` from int to float/double

`truckCompany` (the driver's employer, e.g. "Lalamove Philippines Inc") remains untouched at the document level and is displayed on the driver card in the Fleet Manager dashboard.