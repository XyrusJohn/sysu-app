# SYSU-GO TEAM HANDOFF: OBD Line Items Schema Change — `customerName`

**Date:** 2026-05-30
**From:** sysu-app (backend / Firestore owner)
**Status:** ✅ LIVE — schema is deployed; sysu-go QA needed
**Priority:** HIGH

---

## SUMMARY FOR ANDROID DEV

The `lineItems` array inside every `sap_assignments` Firestore document has **changed schema**. The column formerly labeled **"AMOUNT"** is now **"CUSTOMER NAME"** (delivery recipient / ship-to party). The `quantity` field now accepts decimal values (float/double).

**You need to:**
1. Update your Firestore reads to use `customerName` instead of `amount`
2. Update your OBD table column header from "AMOUNT" → "CUSTOMER NAME"
3. Update `quantity` parsing to handle float values (not just integers)
4. Verify the table renders correctly with test data below

---

## SECTION 1: FIRESTORE SCHEMA CHANGE

### Old `lineItems` item schema (DEPRECATED — do not use)

```json
{
  "obdNumber": "6051555397",
  "quantity": 229,
  "amount": 218359.24
}
```

### New `lineItems` item schema (ACTIVE — use this)

```json
{
  "obdNumber": "6051555397",
  "quantity": 229.5,
  "customerName": "Juan dela Cruz — 123 Adel St. Makati"
}
```

### Field-by-field change

| Field | Old Type | New Type | Action |
|-------|----------|----------|--------|
| `obdNumber` | `string` | `string` | **KEEP** — no change |
| `quantity` | `int64` | `double` / `float` | **CHANGE TYPE** — now allows decimals like `1.5`, `3.25`, `2.0` |
| `amount` | `double` | **REMOVED** | **DELETE** — do NOT read this, it no longer exists in Firestore |
| `customerName` | *(did not exist)* | `string` | **NEW** — read this instead of `amount` |

### IMPORTANT: `truckCompany` is NOT `customerName`

These are **two completely different fields** on **different levels**:

- **`truckCompany`** — lives at the **document level** on `sap_assignments`. It's the driver's trucking company (e.g., "Lalamove Philippines Inc"). This was NEVER inside `lineItems`. It is unchanged.

- **`customerName`** — lives **inside each `lineItems` item**. It's the **delivery recipient / ship-to party** (e.g., "Maria Santos — LRT Station Annex Pasay"). This is what you display in the OBD table.

**Do NOT confuse them.** The OBD table is about _what's being delivered_, not _who's trucking the delivery_.

---

## SECTION 2: DOCUMENT LEVEL vs LINEITEMS — FULL PICTURE

Here is the complete structure of a `sap_assignments` document in Firestore:

```json
{
  "driverId": "abc123",
  "driverName": "Juan dela Cruz",
  "truckPlate": "LMS-9578",
  "truckCompany": "Lalamove Philippines Inc",
  "assignedAt": { "seconds": 1751251200, "nanoseconds": 0 },
  "lineItems": [
    {
      "obdNumber": "6051555397",
      "quantity": 2.0,
      "customerName": "Maria Santos — LRT Station Annex Pasay"
    },
    {
      "obdNumber": "6051555398",
      "quantity": 1.5,
      "customerName": "ABC Corporation — Unit 4B BGC"
    },
    {
      "obdNumber": "6051555396",
      "quantity": 3.25,
      "customerName": "Juan dela Cruz — 123 Adel St. Makati"
    }
  ]
}
```

**For the OBD items table:** Read from `lineItems[]` array.

**The OBD table columns are:**

| Column | Source Field | Data Type | Example |
|--------|-------------|-----------|---------|
| OBD Number | `item.obdNumber` | `string` | "6051555397" |
| QTY | `item.quantity` | `double` / `float` | 2.0, 1.5, 3.25 |
| CUSTOMER NAME | `item.customerName` | `string` | "Maria Santos — LRT Station Annex Pasay" |

---

## SECTION 3: HOW TO READ IN KOTLIN (ANDROID)

### Old code (DEPRECATED — remove amount reading)

```kotlin
// ❌ OLD — do not use amount anymore
val obdNumber = item["obdNumber"] as? String ?: "—"
val amount = item["amount"] as? Double ?: 0.0      // REMOVE THIS
val quantity = item["quantity"] as? Int ?: 0       // WRONG — quantity is now double
```

### New code (USE THIS)

```kotlin
// ✅ NEW — read customerName and float quantity
val obdNumber = item["obdNumber"] as? String ?: "—"

// quantity is a Number (handles both int and double from Firestore)
val quantity = (item["quantity"] as? Number)?.toDouble() ?: 0.0

// customerName is the delivery recipient — NOT the truck company
val customerName = item["customerName"] as? String ?: "—"

// Display example:
// TextView_OBDNumber.text = obdNumber          → "6051555397"
// TextView_Quantity.text = quantity.toString()  → "2.0" or "1.5" or "3.25"
// TextView_CustomerName.text = customerName     → "Maria Santos — LRT Station Annex Pasay"
```

**On Number vs Int for quantity:**
Firestore stores `quantity` as a numeric type. When you read from Firestore in Kotlin, it comes back as `Number`. Use `(item["quantity"] as? Number)?.toDouble()` — this works whether Firestore stored it as integer `2` or double `2.0`. Always call `.toDouble()` to ensure decimal display.

---

## SECTION 4: ANDROID UI CHANGES NEEDED

### 4a. Column Header

Update your OBD items table header from:

| OLD COLUMN HEADER | NEW COLUMN HEADER |
|-------------------|-------------------|
| OBD NUMBER / QTY / **AMOUNT** | OBD NUMBER / QTY / **CUSTOMER NAME** |

In your layout XML (e.g., `activity_queue_details.xml`), find the AMOUNT column header and change to `CUSTOMER_NAME`.

### 4b. item_obd_line.xml (the row item layout)

Change the last TextView from showing `amount` to showing `customerName`:

```xml
<!-- BEFORE (DEPRECATED) -->
<TextView
    android:id="@+id/tvAmount"
    android:layout_width="0dp"
    android:layout_weight="1"
    android:text="@{queue.customerAmount}"   <!-- ← remove this -->
    android:gravity="end"
    android:textColor="@color/text_secondary"
    android:textSize="11sp" />
```

```xml
<!-- AFTER (USE THIS) -->
<TextView
    android:id="@+id/tvCustomerName"
    android:layout_width="0dp"
    android:layout_weight="1"
    android:text="@{queue.customerName}"
    android:gravity="end"
    android:textColor="@color/text_secondary"
    android:textSize="11sp" />
```

Note: RIGHT-ALIGN the customerName column (it's a name + address, long text — right alignment looks cleaner in monospace/Fira Mono).

### 4c. QueueDetailsActivity.kt (data binding)

```kotlin
// BEFORE — remove this:
// val amount = item["amount"] as? Double ?: 0.0
// val formattedAmount = "PHP ${String.format("%,.2f", amount)}"

// AFTER — add this:
val obdNumber = item["obdNumber"] as? String ?: "—"
val quantity = (item["quantity"] as? Number)?.toDouble() ?: 0.0
val customerName = item["customerName"] as? String ?: "—"

// For display:
// quantity: use toString() directly — already a number
//   e.g. 2.0.toString() = "2.0", 1.5.toString() = "1.5"
// customerName: use directly as string
```

---

## SECTION 5: TEST DATA — USE THIS TO VERIFY YOUR IMPLEMENTATION

### Firestore test payload

Write this data to any `sap_assignments/{docId}` document in Firebase Console to test your Android rendering:

```json
{
  "driverId": "test-driver-001",
  "driverName": "Test Driver",
  "truckPlate": "TEST-0001",
  "truckCompany": "Lalamove Philippines Inc",
  "assignedAt": { "seconds": 1751251200, "nanoseconds": 0 },
  "lineItems": [
    {
      "obdNumber": "6051555397",
      "quantity": 2.0,
      "customerName": "Juan dela Cruz — 123 Adel St. Makati"
    },
    {
      "obdNumber": "6051555398",
      "quantity": 1.5,
      "customerName": "ABC Corporation — Unit 4B BGC Taguig"
    },
    {
      "obdNumber": "6051555396",
      "quantity": 3.25,
      "customerName": "Maria Santos — LRT Station Annex Pasay"
    }
  ]
}
```

**Expected table render with this data:**

```
┌─────────────────┬──────┬──────────────────────────────────────────┐
│ OBD NUMBER      │ QTY  │ CUSTOMER NAME                             │
├─────────────────┼──────┼──────────────────────────────────────────┤
│ 6051555397      │ 2    │ Juan dela Cruz — 123 Adel St. Makati      │
│ 6051555398      │ 1.5  │ ABC Corporation — Unit 4B BGC Taguig    │
│ 6051555396      │ 3.25 │ Maria Santos — LRT Station Annex Pasay   │
└─────────────────┴──────┴──────────────────────────────────────────┘
```

### Important display notes:

- **QTY column** must show decimals: `2.0` shows as `2`, `1.5` shows as `1.5`, `3.25` shows as `3.25`
- **CUSTOMER NAME** is a full address string — make sure the column is wide enough (it can contain up to 100+ characters including the address)
- **Right-align** the QTY and CUSTOMER NAME columns for readability
- **OBD NUMBER** is a string — left-align or center-align, monospace font preferred

---

## SECTION 6: FLOATING POINT QUANTITY — BEHAVIOR

`quantity` values you will see in Firestore:

| Value in Firestore | Firestore Type | Kotlin read as | Display |
|-------------------|---------------|----------------|---------|
| `2` | int64 | `Number(2.0)` | "2" or "2.0" |
| `2.0` | double | `Number(2.0)` | "2" or "2.0" |
| `1.5` | double | `Number(1.5)` | "1.5" |
| `3.25` | double | `Number(3.25)` | "3.25" |

**Kotlin parsing tip:**
```kotlin
// Safe way to read quantity (handles both int and double from Firestore)
val qty = (item["quantity"] as? Number)?.toDouble() ?: 0.0
val qtyDisplay = if (qty == qty.toLong().toDouble()) {
    // It's a whole number — display without decimal (e.g., "2")
    qty.toLong().toString()
} else {
    // It has decimals — display with decimal (e.g., "1.5", "3.25")
    qty.toString()
}
```

This gives cleaner display: `2.0` → shows as `2`, but `1.5` still shows as `1.5`.

---

## SECTION 7: "DOES EACH OBD HAVE A DIFFERENT CUSTOMER?"

**Yes.** This is the key requirement from the customer. Each OBD item in the `lineItems` array can have a different `customerName`. One dispatch can deliver to multiple recipients.

Example:
```
Dispatch #1234 is assigned to driver "Juan"
  → Line item 1: OBD #6051555397 → delivered to "Maria Santos — LRT Station Annex"
  → Line item 2: OBD #6051555398 → delivered to "ABC Corporation — BGC"
  → Line item 3: OBD #6051555396 → delivered to "Juan dela Cruz — Makati"
```

So each row in the OBD table must show the specific `customerName` for that OBD. Do NOT use the document-level `truckCompany` for any row in the OBD table.

---

## SECTION 8: ERROR CASES — HOW TO HANDLE

### Missing `customerName` field in old documents

Some pre-migration documents may still have the old schema (with `amount` instead of `customerName`). Handle gracefully:

```kotlin
// Safe read with fallback
val customerName = when {
    item.containsKey("customerName") -> item["customerName"] as? String ?: "—"
    item.containsKey("truckCompany") -> item["truckCompany"] as? String ?: "—"  // backstop (wrong data, but visible)
    else -> "—"
}
```

After the migration is complete (sysu-app has run the script), all documents will have `customerName`. The fallback is only for any documents that weren't migrated.

### Missing `quantity` or null

```kotlin
val quantity = (item["quantity"] as? Number)?.toDouble() ?: 0.0
// Never shows null — defaults to 0.0
```

---

## SECTION 9: FIRESTORE QUERY FOR DRIVER APP

How your Android app should read this data:

```kotlin
// Collection: "sap_assignments"
// Document ID: the dispatch/assignment ID (same as what's shown in the queue)
//
// Read the full document:
db.collection("sap_assignments")
    .document(assignmentId)
    .addSnapshotListener { snapshot, error ->
        if (error != null) { /* handle error */ return@addSnapshotListener }

        snapshot?.data?.let { data ->
            val lineItems = data["lineItems"] as? List<Map<String, Any>> ?: emptyList()

            lineItems.forEach { item ->
                val obdNumber = item["obdNumber"] as? String ?: "—"
                val quantity = (item["quantity"] as? Number)?.toDouble() ?: 0.0
                val customerName = item["customerName"] as? String ?: "—"

                // Add to your list for display
            }
        }
    }
```

---

## SECTION 10: VERIFICATION CHECKLIST FOR SYSU-GO QA

Use this list to verify your implementation is correct:

- [ ] `amount` field is **NOT read** anywhere in your code (search for `item["amount"]` or `item.get("amount")`)
- [ ] `customerName` field is correctly read and displayed in each OBD row
- [ ] `quantity` displays as a number with decimals when decimal exists (1.5, not rounded to 2)
- [ ] OBD table column header says "CUSTOMER NAME" not "AMOUNT"
- [ ] Customer names show delivery recipient (recipient name + address), NOT truck company
- [ ] Each OBD row can show a different `customerName` (not a copy of document-level `truckCompany`)
- [ ] Test data from Section 5 renders correctly in your table

---

## SECTION 11: CONTACT

For questions about the Firestore schema, migration status, or the data format:

- **Backend / Firestore owner:** sysu-app team
- **Android app owner:** sysu-go team

To confirm migration is complete, ask sysu-app when the one-time migration script was executed on production Firestore.

---

## APPENDIX: MIGRATION LOG (for reference)

| Date | Event |
|------|-------|
| 2026-05-30 | sysu-app deployed new schema writes to `dashboard.js` |
| 2026-05-30 | sysu-app ran migration script on all `sap_assignments` docs |
| 2026-05-30 | Firestore security rules updated — `amount` forbidden in `lineItems` |
| 2026-05-30 | **This handoff sent to sysu-go** |
| PENDING | sysu-go team QA — verify driver app renders correctly |

---

_Prepared by: sysu-app development team — 2026-05-30_