# OBD Line Items Schema Change — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change `sap_assignments.lineItems[]` schema from `{obdNumber, quantity, amount}` to `{obdNumber, quantity (float), customerName}`. Customer wants the OBD table on the driver app to show delivery recipient (ship-to party) instead of monetary amount. Each OBD line can have a different recipient.

**Architecture:** Approach A (dual-write + background migration) — deploy new code first (new writes use new schema), then run a one-time Firestore migration on all existing documents. Gives a clean rollback path: new writes always use new schema, migration can be re-run anytime.

**Tech Stack:** Firebase Firestore, Firebase Admin SDK (Node.js migration script), dashboard.js (vanilla JS)

---

## Pre-flight: Key Findings From Codebase

Before starting, know these facts:

- **`truckCompany` is NOT inside `lineItems`** — it is a document-level field on `sap_assignments` (the driver's trucking company, shown on the driver card on the dashboard). It was never inside `lineItems`. It stays at the document level. Only `amount` is being removed from `lineItems`.
- **`amount` IS inside `lineItems`** — present in both write methods as `amount: Number(r.Amount) || 0`. Must be removed from the object.
- **New field source:** `ShipToPartyName` from SAP OData is already available in `receivingRecords` — it's displayed in the dispatch detail modal at dashboard.js line 2304-2305. Use this as `customerName`. Falls back to `r.ShipToParty` if `ShipToPartyName` is empty.
- **`quantity` type:** `Number(r.Quantity)` returns an integer if Quantity is a whole number. Use `parseFloat(r.Quantity)` to preserve decimal values like 1.5, 3.25.

## File Map

```
frontend/src/pages/dashboard.js              — 2 method updates: _confirmFleetAssignment(), confirmAssignment()
scripts/migrate-obd-lineitems.js              — NEW: one-time Firestore migration script
frontend/firestore.rules                      — optional schema validation
docs/superpowers/specs/.../2026-05-30-obd-line-items-sap-assignments-design.md  — UPDATE
docs/superpowers/plans/.../2026-05-29-sap-export-truck-company-plan.md          — UPDATE note
```

---

## TASK 1: Update `_confirmFleetAssignment()` in dashboard.js

**File:** `frontend/src/pages/dashboard.js` — `_confirmFleetAssignment()` method, around line 1759

The Fleet Manager single-driver assignment path. Change the `lineItems` mapping from the old schema to the new schema.

- [ ] **Step 1: Locate the existing `lineItems` mapping code inside `_confirmFleetAssignment()`**

Search for the `lineItems` block. It should look exactly like:
```js
const lineItems = receivingRecords
    .filter(r => r.OBDNumber && r.OBDNumber.trim() !== "")
    .map(r => ({
        obdNumber: r.OBDNumber,
        quantity: Number(r.Quantity) || 0,
        amount: Number(r.Amount) || 0,
    }));
```

If `amount` is already absent from this code, the change from a previous session already happened — skip to Task 2.

- [ ] **Step 2: Replace the `lineItems` mapping with the new schema**

Use Edit to replace the exact block above with:
```js
const lineItems = receivingRecords
    .filter(r => r.OBDNumber && r.OBDNumber.trim() !== "")
    .map(r => ({
        obdNumber: r.OBDNumber,
        quantity: parseFloat(r.Quantity) || 0,
        customerName: r.ShipToPartyName || r.ShipToParty || "",
    }));
```

Key changes from old schema:
- `quantity: Number(r.Quantity) || 0` → `quantity: parseFloat(r.Quantity) || 0` (float vs int)
- Remove line `amount: Number(r.Amount) || 0`
- Add line `customerName: r.ShipToPartyName || r.ShipToParty || ""`

- [ ] **Step 3: Verify the change**

```powershell
Select-String -Path frontend/src/pages/dashboard.js -Pattern "customerName: r\.ShipToPartyName" -AllMatches
```
Expected: finds the new `customerName` assignment inside `_confirmFleetAssignment()`. Only one match at this stage.

```powershell
Select-String -Path frontend/src/pages/dashboard.js -Pattern "amount: Number"
```
Expected: finds zero matches for `amount: Number` inside `_confirmFleetAssignment()`. If still found, the edit was not applied correctly.

- [ ] **Step 4: Commit**

```powershell
git add frontend/src/pages/dashboard.js
git commit -m "feat(dashboard): remove amount from lineItems, add customerName in _confirmFleetAssignment"
```

---

## TASK 2: Update `confirmAssignment()` in dashboard.js

**File:** `frontend/src/pages/dashboard.js` — `confirmAssignment()` method, around line 2433

Does the same lineItems mapping as `_confirmFleetAssignment()`. Apply the identical change.

- [ ] **Step 1: Locate the `lineItems` mapping inside `confirmAssignment()`**

Find the block:
```js
const lineItems = receivingRecords
    .filter(r => r.OBDNumber && r.OBDNumber.trim() !== "")
    .map(r => ({
        obdNumber: r.OBDNumber,
        quantity: Number(r.Quantity) || 0,
        amount: Number(r.Amount) || 0,
    }));
```
This is in `confirmAssignment()`, not `_confirmFleetAssignment()`. Use surrounding context (`const receivingRecords = this.state.sapGroupedByDispatch[dispatchKey] || [];` which precedes it) to disambiguate before editing.

If `amount` is already absent, skip to Task 3.

- [ ] **Step 2: Replace with the new schema**

```js
const lineItems = receivingRecords
    .filter(r => r.OBDNumber && r.OBDNumber.trim() !== "")
    .map(r => ({
        obdNumber: r.OBDNumber,
        quantity: parseFloat(r.Quantity) || 0,
        customerName: r.ShipToPartyName || r.ShipToParty || "",
    }));
```

- [ ] **Step 3: Verify the change**

```powershell
Select-String -Path frontend/src/pages/dashboard.js -Pattern "customerName: r\.ShipToPartyName" -AllMatches
```
Expected: now finds TWO matches (one in each method).

```powershell
Select-String -Path frontend/src/pages/dashboard.js -Pattern "amount: Number"
```
Expected: finds zero matches. Both methods updated.

- [ ] **Step 4: Commit**

```powershell
git add frontend/src/pages/dashboard.js
git commit -m "feat(dashboard): remove amount from lineItems, add customerName in confirmAssignment"
```

---

## TASK 3: Write and run the Firestore migration script

**File:** Create: `scripts/migrate-obd-lineitems.js`

One-time Node.js script using Firebase Admin SDK. Reads ALL `sap_assignments` documents, transforms every item in each `lineItems` array from the old schema to the new schema. All other document fields are preserved untouched.

IMPORTANT: This migration runs AFTER the dashboard.js code is deployed so new writes use the new schema. It only migrates pre-existing documents from the old schema.

- [ ] **Step 1: Create the scripts directory**

```powershell
New-Item -ItemType Directory -Force -Path scripts
```

- [ ] **Step 2: Write the migration script**

```js
// scripts/migrate-obd-lineitems.js
// One-time migration: sap_assignments lineItems schema change
// Transforms: {obdNumber, quantity, amount} → {obdNumber, quantity (float), customerName}
// After running successfully, delete this file — it should not live in the repo as a runnable script.

const admin = require("firebase-admin");

// Option A: Use service account JSON file (adjust path to match your project)
const serviceAccount = require("../frontend/src/config/firebase-service-account.json");
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

// Option B: If using GOOGLE_APPLICATION_CREDENTIALS env var instead, comment out Option A and uncomment:
// admin.initializeApp({
//     credential: admin.credential.applicationDefault(),
// });

const DB = () => admin.firestore();
const COLLECTION = "sap_assignments";
const BATCH_SIZE = 500;

async function migrateLineItems() {
    console.log("========================================");
    console.log("sap_assignments lineItems Migration");
    console.log("Target schema: { obdNumber, quantity (float), customerName }");
    console.log("Removing: amount");
    console.log("========================================");
    console.log("");

    const collectionRef = DB().collection(COLLECTION);
    let totalDocs = 0;
    let totalMigrated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    try {
        const snapshot = await collectionRef.get();
        totalDocs = snapshot.size;
        console.log(`Found ${totalDocs} documents in ${COLLECTION}`);
        console.log("");

        if (totalDocs === 0) {
            console.log("Nothing to migrate. Exiting.");
            process.exit(0);
        }

        let batch = DB().batch();
        let batchCount = 0;

        for (const docSnap of snapshot.docs) {
            const docRef = docSnap.ref;
            const data = docSnap.data();
            const lineItems = data.lineItems;

            // Skip docs with no lineItems array
            if (!Array.isArray(lineItems) || lineItems.length === 0) {
                totalSkipped++;
                continue;
            }

            // Check if already migrated (has customerName and no amount)
            const first = lineItems[0];
            if (first && typeof first.customerName === "string" && !("amount" in first)) {
                console.log(`  SKIP (already migrated): ${docSnap.id}`);
                totalSkipped++;
                continue;
            }

            // Transform each item in lineItems: remove amount, ensure quantity is float, add customerName
            const newLineItems = lineItems.map((item) => ({
                obdNumber: item.obdNumber || "",
                quantity: parseFloat(item.quantity) || 0,
                customerName: item.customerName || item.truckCompany || "",
            }));

            batch.update(docRef, { lineItems: newLineItems });
            batchCount++;
            console.log(`  QUEUED: ${docSnap.id}`);

            // Commit batch when it reaches BATCH_SIZE
            if (batchCount >= BATCH_SIZE) {
                await batch.commit();
                console.log(`  [Batch committed: ${batchCount} docs]`);
                totalMigrated += batchCount;
                batch = DB().batch();
                batchCount = 0;
            }
        }

        // Commit any remaining docs
        if (batchCount > 0) {
            await batch.commit();
            console.log(`  [Final batch committed: ${batchCount} docs]`);
            totalMigrated += batchCount;
        }

        console.log("");
        console.log("========================================");
        console.log("MIGRATION COMPLETE");
        console.log(`Total documents found  : ${totalDocs}`);
        console.log(`Documents migrated      : ${totalMigrated}`);
        console.log(`Documents skipped       : ${totalSkipped} (empty lineItems or already migrated)`);
        console.log(`Errors                  : ${totalErrors}`);
        console.log("========================================");
        process.exit(0);

    } catch (error) {
        console.error("Migration FAILED:", error.message);
        process.exit(1);
    }
}

migrateLineItems();
```

Note on service account: The file `frontend/src/config/firebase-service-account.json` must exist. If your project uses `GOOGLE_APPLICATION_CREDENTIALS` environment variable instead, replace the `admin.initializeApp` block accordingly. Confirm with `Test-Path frontend\src\config\firebase-service-account.json`.

Note on backfill: `customerName: item.customerName || item.truckCompany || ""` means if `customerName` already exists it takes precedence. If not, `truckCompany` is used as fallback (both strings). After migration, all docs will have `customerName` populated from whatever was available.

- [ ] **Step 3: Verify Firebase Admin SDK is available**

```powershell
Test-Path "frontend\node_modules\firebase-admin\package.json"
```
If False, install it:
```powershell
cd frontend; npm install firebase-admin --save-dev
```

- [ ] **Step 4: Dry run — verify which docs will be migrated (no Firestore writes)**

Add this at line 5 in the script (after `const COLLECTION = ...`):
```js
const DRY_RUN = process.env.DRY_RUN === "true";
if (DRY_RUN) console.log("[DRY RUN] No writes will be performed.\n");
```

And change the `batch.update(docRef, ...)` block to:
```js
if (DRY_RUN) {
    console.log(`  DRY-RUN would migrate: ${docSnap.id}`);
    console.log(`    Old lineItems[0]:`, JSON.stringify(lineItems[0]));
    console.log(`    New lineItems[0]:`, JSON.stringify(newLineItems[0]));
} else {
    batch.update(docRef, { lineItems: newLineItems });
}
```

Run dry run:
```powershell
$env:DRY_RUN = "true"; node scripts/migrate-obd-lineitems.js
```

Review the output:
- Confirm docs listed are real `sap_assignments` docs (not test data, not artifacts)
- Confirm the `Old` → `New` transform shows `amount` field gone, `customerName` present
- Confirm `quantity` is a valid float in the New output

If dry run looks wrong, stop and investigate before proceeding to Step 5.

- [ ] **Step 5: Run the actual migration**

```powershell
node scripts/migrate-obd-lineitems.js
```

Expected: each doc gets QUEUED, batches commit periodically, final summary prints totals. No errors should appear.

- [ ] **Step 6: Verify migration results in Firestore console**

Open Firebase Console → Firestore → `sap_assignments` collection.
Pick a migrated document:
- `lineItems[0]` should have ONLY `{obdNumber, quantity, customerName}` — no `amount` field at all
- `quantity` should be a Firestore number, shown as e.g. `2.5` (not a string `"2.5"`)
- `customerName` should be a non-empty string from `ShipToPartyName` (or backfilled from `truckCompany` from the document level for early migrated docs — acceptable for the one-time migration)

- [ ] **Step 7: Commit then delete the script**

After migration is confirmed successful, remove the script from the repo:

```powershell
git add scripts/migrate-obd-lineitems.js
git commit -m "scripts: add one-time sap_assignments lineItems migration script"
# Immediately delete it after commit:
Remove-Item scripts/migrate-obd-lineitems.js
git add scripts/migrate-obd-lineitems.js   # or just git add -A
git commit -m "scripts: remove migration script after successful run"
```

The script must not live in the repo as a runnable security risk.

---

## TASK 4: Update Firestore security rules

**File:** `frontend/firestore.rules`

Current `sap_assignments` rules are fully permissive — no schema validation at all. They already accept any authenticated write, including the new schema, so no urgent action is needed. However, add an explicit schema validation rule to declare intent and prevent future accidental regressions that could reintroduce the `amount` field.

- [ ] **Step 1: Read the current `sap_assignments` rule block**

Find this exact block in `frontend/firestore.rules`:
```
match /sap_assignments/{shipmentId} {
  allow read:  if true;
  allow write: if request.auth != null;
}
```

- [ ] **Step 2: Add schema validation to the create rule**

Replace the `sap_assignments` rule block with:
```
match /sap_assignments/{shipmentId} {
  allow read:  if true;
  allow write: if request.auth != null;

  // Validate new lineItems schema on create only.
  // - customerName required (string): the delivery recipient / ship-to party
  // - quantity required (number): float/double, e.g. 2.5, 3.25
  // - obdNumber required (string): the SAP delivery/OBD number
  // - amount is explicitly forbidden inside each line item
  allow create: if request.auth != null
    && request.resource.data.lineItems.size() > 0
    && request.resource.data.lineItems[0].obdNumber is string
    && request.resource.data.lineItems[0].quantity is number
    && request.resource.data.lineItems[0].customerName is string
    && !("amount" in request.resource.data.lineItems[0]);
}
```

Key design decisions:
- `allow write: if request.auth != null` remains for UPDATE operations (lets migration scripts update existing docs without hitting the create rule)
- `allow create` enforces the schema only on initial document creation
- `!("amount" in request.resource.data.lineItems[0])` explicitly blocks `amount` from being reintroduced

If you prefer to keep rules fully permissive (no schema validation), skip this task entirely — the old permissive rules already allow the new schema.

- [ ] **Step 3: Deploy updated rules**

Using Firebase CLI:
```powershell
cd frontend
npx firebase deploy --only firestore:rules
```

Or paste the updated rules manually in Firebase Console → Firestore → Rules tab.

- [ ] **Step 4: Commit**

```powershell
git add frontend/firestore.rules
git commit -m "rules(firestore): validate lineItems schema in sap_assignments — customerName required, amount and truckCompany forbidden inside lineItems"
```

---

## TASK 5: Update the design spec document

**File:** `docs/superpowers/specs/2026-05-30-obd-line-items-sap-assignments-design.md`

The existing design spec documents the old `{obdNumber, quantity, amount}` schema. Update it to reflect the new approved schema.

- [ ] **Step 1: Read the current design doc**

Open: `C:\Users\xyver\WebstormProjects\sysu-app\docs\superpowers\specs\2026-05-30-obd-line-items-sap-assignments-design.md`

- [ ] **Step 2: Update Section 2 (Schema Change)**

Replace the entire Section 2 with:

```markdown
## 2. Schema Change

### `lineItems[]` item schema — NEW (effective 2026-05-30)

```js
lineItems: [
  {
    obdNumber:   String,   // e.g. "6051555397" — SAP OBD/Delivery number
    quantity:    Number,   // e.g. 2.0, 1.5, 3.25 — float/double, decimals allowed
    customerName: String,  // e.g. "Juan dela Cruz — 123 Adel St. Makati"
                          // Delivery recipient / ship-to party (NOT truck company!)
  }
]
```

**What changed from the old schema:**
- `amount: Number` — REMOVED (was PHP monetary value, no longer displayed)
- `quantity` type changed: was int64, now float/double (allows 1.5, 3.25, etc.)
- `customerName` ADDED — delivery recipient name from SAP `ShipToPartyName` field

`truckCompany` was never inside `lineItems` — it's a document-level field on `sap_assignments` (the driver's trucking company). It remains unchanged.
```

- [ ] **Step 3: Update Section 5 (Sample Test Data)**

Replace with:

```markdown
## 5. Sample Test Data

```json
{
  "lineItems": [
    { "obdNumber": "6051555397", "quantity": 2.0,  "customerName": "Juan dela Cruz — 123 Adel St. Makati" },
    { "obdNumber": "6051555398", "quantity": 1.5,  "customerName": "ABC Corporation — Unit 4B BGC Taguig" },
    { "obdNumber": "6051555396", "quantity": 3.25, "customerName": "Maria Santos — LRT Station Annex Pasay" }
  ]
}
```

**Expected driver app render:**
```
OBD NUMBER      QTY   CUSTOMER NAME
6051555397       2    Juan dela Cruz — 123 Adel St. Makati
6051555398     1.5    ABC Corporation — Unit 4B BGC Taguig
6051555396    3.25    Maria Santos — LRT Station Annex Pasay
```

Note: Each OBD line can have a DIFFERENT `customerName` — one dispatch can have multiple delivery recipients.
```

- [ ] **Step 4: Update Section 6 (Backwards Compatibility)**

Replace with:

```markdown
## 6. Backwards Compatibility and Migration

A one-time Firestore migration is required for existing `sap_assignments` documents.

**Migration logic (one-time, applied 2026-05-30):**
```js
newLineItems = oldLineItems.map(item => ({
    obdNumber:   item.obdNumber,
    quantity:    parseFloat(item.quantity),
    customerName: item.customerName || item.truckCompany || "",
    // amount — removed (not written back)
}));
```

After migration, all `sap_assignments` documents have `lineItems` with only `{obdNumber, quantity, customerName}`. Old documents without `customerName` are backfilled from `truckCompany` (driver's company) — acceptable for the one-time migration.

The `amount` field inside `lineItems` is fully removed. `truckCompany` stays as a document-level field (unaffected).
```

Also update Section 1 (Overview) to mention `customerName` replacing `amount`, and update the handoff note in Section 4 (Files to Modify) to reflect the new schema fields.

- [ ] **Step 5: Commit**

```powershell
git add docs/superpowers/specs/2026-05-30-obd-line-items-sap-assignments-design.md
git commit -m "docs: update OBD lineItems schema design — customerName replaces amount, quantity is float"
```

---

## TASK 6: Update the existing truckCompany plan (clarification note)

**File:** `docs/superpowers/plans/2026-05-29-sap-export-truck-company-plan.md`

`truckCompany` has been confirmed as a document-level field (driver's trucking company), NOT inside `lineItems`. Add a clarification note so future engineers don't confuse the two.

- [ ] **Step 1: Append a clarification at the end of the plan**

Read the file, then add to the end:

```markdown
---

## Clarification (2026-05-30)

**`truckCompany` (driver's trucking company) is a document-level field on `sap_assignments` — it is NOT inside `lineItems` and is NOT affected by the OBD lineItems schema change.**

The OBD lineItems schema change (2026-05-30) only affects the `lineItems[]` array:
- REMOVED from `lineItems`: `amount`
- ADDED to `lineItems`: `customerName` (delivery recipient / ship-to party)
- CHANGED in `lineItems`: `quantity` from int to float/double

`truckCompany` (the driver's employer, e.g. "Lalamove Philippines Inc") remains untouched at the document level and is displayed on the driver card in the Fleet Manager dashboard.
```

- [ ] **Step 2: Commit**

```powershell
git add docs/superpowers/plans/2026-05-29-sap-export-truck-company-plan.md
git commit -m "docs: clarify truckCompany is doc-level field, unaffected by lineItems migration"
```

---

## TASK 7: Notify sysu-go team (manual step)

After Tasks 1–6 are complete, message the sysu-go team. Include:

- ✅ Confirmation that all `sap_assignments` documents have the new schema
- ✅ The test data payload (from Task 5, Section 5):
```json
[
  { "obdNumber": "6051555397", "quantity": 2.0,  "customerName": "Juan dela Cruz — 123 Adel St. Makati" },
  { "obdNumber": "6051555398", "quantity": 1.5,  "customerName": "ABC Corporation — Unit 4B BGC Taguig" },
  { "obdNumber": "6051555396", "quantity": 3.25, "customerName": "Maria Santos — LRT Station Annex Pasay" }
]
```
- ✅ Expected render: columns are now OBD NUMBER | QTY | CUSTOMER NAME
- ✅ `quantity` accepts decimal values (1.5, 3.25)

---

## Rollout Sequence

| Step | Task | Done when |
|------|------|-----------|
| 1 | TASK 1 — Update `_confirmFleetAssignment()` | Committed |
| 2 | TASK 2 — Update `confirmAssignment()` | Committed |
| 3 | TASK 3 — Migration script: dry run, then run | Confirmed in Firestore |
| 4 | TASK 4 — Update Firestore rules | Rules deployed |
| 5 | TASK 5 — Update design spec doc | Committed |
| 6 | TASK 6 — Update truckCompany plan note | Committed |
| 7 | TASK 7 — Notify sysu-go team | Message sent |

**After step 2, new writes use the new schema. The migration in step 3 handles backfilling existing documents. Order matters: deploy code first, then migrate.**

---

## Success Verification

In Firestore Console, for any `sap_assignments` document:

- [ ] `lineItems[0]` has exactly three fields: `obdNumber`, `quantity`, `customerName`
- [ ] `amount` field is absent from all lineItems items
- [ ] `quantity` is displayed as a number (float/double), decimals preserved (e.g. 2.5, not "2.5")
- [ ] `customerName` shows ship-to party (delivery recipient), NOT a truck company name: e.g. `"Juan dela Cruz — 123 Adel St. Makati"`
- [ ] Document-level `truckCompany` field is still present (unchanged)

---

## Out of Scope

- SAP OData backend — only the frontend mapping changes (`r.ShipToPartyName` was already there in the data)
- sysu-go driver app changes — separate team/repo
- Firestore indexes — no index changes needed
- Authentication or authorization changes — current auth is unchanged
- `amount` or `truckCompany` at the document level (outside `lineItems`) — these were never inside `lineItems`, they stay