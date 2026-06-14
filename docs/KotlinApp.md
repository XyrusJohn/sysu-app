# SYSU Mobile App (Kotlin) — Integration Guide

## Overview
The SYSU mobile app is a **driver-facing Android application** built with Kotlin and Jetpack Compose (or Views). Its primary function: scan the QR code displayed on the yard TV, verify the token with thebackend, and add the driver to the queue.

---

## QR Scan → Queue Flow

```
TV displays QR                Driver opens app          App parses token
(qr-generator.html)     →     and scans QR       →    from QR URL
                                  ↓
                        POST /api/qr/scan
                        { token, driverId, driverName }
                                  ↓
                          Backend verifies
                          + adds to Firestore queue
                                  ↓
                         App shows "You're in the queue!"
                         (GCash-style success animation)
```

---

## API Contract

**Base URL:** `https://sysu-web-production.up.railway.app`

### `POST /api/qr/scan`

Called immediately after the QR is scanned and the token is parsed from the URL.

**Headers:**
```
Content-Type: application/json
Authorization: Bearer <Firebase ID token>  (optional, for backend auth)
```

**Request Body:**
```json
{
  "token": "SYS-0L6SKCV592L",
  "driverId": "firebaseUidString",
  "driverName": "Juan Dela Cruz"
}
```

| Field | Source | Notes |
|-------|--------|-------|
| `token` | Parsed from scanned QR URL (`?token=SYS-XXX`) | Strip any query params before token |
| `driverId` | Firebase Authentication UID | `FirebaseAuth.getInstance().currentUser.uid` |
| `driverName` | Firebase user display name | `FirebaseAuth.getInstance().currentUser.displayName` |

**Responses:**

| HTTP Status | JSON Body | Meaning | App Action |
|-------------|-----------|---------|------------|
| `200` | `{"success": true, "message": "Successfully joined the queue"}` | Driver added | Show success animation/sound |
| `400` | `{"success": false, "message": "Driver is already in the queue"}` | Already in queue | Show info toast "Already in queue" |
| `410` | `{"success": false, "message": "Token expired"}` | Token too old | Show error "QR expired, please scan again" |
| `410` | `{"success": false, "message": "Token already used"}` | Already scanned | Show error "QR already used" |
| `401` | `{"success": false, "message": "Invalid or expired token"}` | Token not found | Show error "Invalid QR" |
| `500` | `{"success": false, "message": "Internal server error"}` | Server error | Show error "Server error, please try again" |

---

## QR URL Format
The QR on the TV contains this URL:
```
https://sysu-web-5a25d.web.app?token=SYS-0L6SKCV592L
```

The Kotlin app needs to:
1. Use ML Kit or ZXing to scan the QR
2. Parse the `token` query parameter from the URL
3. Strip any whitespace/newlines
4. Validate it starts with `SYS-`
5. Call `POST /api/qr/scan` with the token

**Example token extraction:**
```kotlin
// Using Android's Uri:
val scannedText = cameraView.scanResult // e.g. "https://sysu-web-5a25d.web.app?token=SYS-0L6SKCV592L"
val uri = Uri.parse(scannedText)
val token = uri.getQueryParameter("token") // "SYS-0L6SKCV592L"
```

---

## Retrofit Setup

```kotlin
interface SysuApi {
    @POST("api/qr/scan")
    suspend fun scanToken(@Body body: ScanRequest): Response<ScanResponse>
}

data class ScanRequest(
    val token: String,
    val driverId: String,
    val driverName: String
)

data class ScanResponse(
    val success: Boolean,
    val message: String
)
```

```kotlin
// OkHttp + Moshi (or Gson) implementation
val client = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(10, TimeUnit.SECONDS)
    .writeTimeout(10, TimeUnit.SECONDS)
    .build()

val retrofit = Retrofit.Builder()
    .baseUrl("https://sysu-web-production.up.railway.app/")
    .client(client)
    .addConverterFactory(MoshiConverterFactory.create())
    .build()
```

---

## GCash-Style UI/UX

After a successful scan (`200`), the app should show:
1. **Immediate haptic feedback** (vibrate 100ms)
2. **Sound** — play a short success chime/sound
3. **Animated checkmark** — green checkmark scaling in (GCash-green theme: `#16a34a`)
4. **Text:** "You're in the queue!" or "Success!"
5. **Optional:** Driver's name displayed
6. **Auto-dismiss** — return to scanner/home after 3 seconds

On error:
1. **Haptic feedback** — short buzz
2. **Error sound** — short negative tone
3. **Red/Orange toast/message** showing the error message from the `message` field
4. **"Try Again" button** or auto-retry prompt

---

## Token Expiry
Tokens expire **5 minutes** after generation. If the driver holds the phone to the QR for more than 5 minutes before tapping "Join Queue", they will get a `410` ("Token expired"). The app should show "QR expired, please scan again".

---

## Firestore Write (what the backend does)
After verifying the token, the backend writes a document to Firestore `queue` collection:

```json
{
  "driverId": "firebaseUidString",
  "driverName": "Juan Dela Cruz",
  "token": "SYS-0L6SKCV592L",
  "entryTime": "<server timestamp>",
  "status": "waiting",
  "isAssigned": false,
  "position": null
}
```

This document triggers the **real-time update on the QR Generator TV** — the toast with driver's name appears on the yard display.

---

## Notes
- Do NOT call `GET /api/qr/verify` — the scan endpoint does both verify + enqueue atomically
- The `driverId` field should match the Firebase UID (not a custom ID)
- `driverName` is stored directly on the queue document so the TV can display it without extra lookups
- If the app was previously in background and the token is 5+ minutes old, re-scan before submitting