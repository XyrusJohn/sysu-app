# SAP Assignment OBD Line Items — Schema Design

**Date:** 2026-05-30
**Status:** Approved
**Implemented by:** sysu-app (this repo)

---

## 1. Overview

Add an OBD (Outbound Delivery) line items array to each document in the `sap_assignments` Firestore collection. This data is consumed by the sysu-go driver app's **My Queue** screen at the guard checkpoint — drivers need to verify shipment items at the booth. Rendered as table: OBDNumber | Quantity | CustomerName. Quantity is a float/double (e.g. 2.0, 1.5, 3.25).

---

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

---

## 3. Data Flow

```
sysu-app backend
  writes to → Firestore sap_assignments/{id}/lineItems  (populated from SAP export or manual entry)

sysu-go driver app (separate repo)
  reads → sap_assignments/{id}  → displays My Queue OBD table
```

`lineItems` is written at the same time as the rest of the `sap_assignments` document — in `_confirmFleetAssignment()` and `confirmAssignment()`, or backfilled/updated separately if data comes from a different source.

---

## 4. Files to Modify

| File | Change |
|------|--------|
| `frontend/src/pages/dashboard.js` | `_confirmFleetAssignment()`: include `lineItems` in `sap_assignments` write |
| `frontend/src/pages/dashboard.js` | `confirmAssignment()`: include `lineItems` in `sap_assignments` write |
| `frontend/src/pages/dashboard.js` | `exportOrdersExcel()`: keep existing, no OBD table column needed yet |

> **Note:** `sysu-go` (Kotlin/driver app) is a **separate repo**. It owns the read side. The handoff prompt for that team is:
> - Add `lineItems` array to `sap_assignments` Firestore reads, render as table in **My Queue** screen
> - Fields: `OBD Number` | `Quantity` | `Customer Name`
> - Consumes: `obdNumber` (string), `quantity` (number/float), `customerName` (string)

---

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

---

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