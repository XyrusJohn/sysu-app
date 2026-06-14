# SYSU Web App — Documentation

## Overview
The SYSU web app serves two roles:
1. **QR Generator** — displayed on a TV at the yard entrance. Shows a QR code that drivers scan with the SYSU mobile app to join the queue.
2. **Dashboard** — for admin/fleet manager users to monitor trucks, dispatch, and manage the queue.

---

## Project Structure
```
frontend/
├── index.html              # Login/landing page
├── dashboard.html          # Admin fleet dashboard
├── qr-generator.html       # QR display page (for TV / qr_generator role)
├── queue-management.html   # Admin queue management panel
├── scan-result.html       # Driver confirmation page (after QR scan via web)
├── public/                # Static files synced here for Firebase deploy
│   ├── qr-generator.html
│   └── scan-result.html
├── dist/                  # Vite build output (deployed to Firebase Hosting)
├── src/
│   ├── main.js             # Auth guard / router
│   ├── pages/
│   │   ├── index.js        # Login page logic
│   │   └── dashboard.js    # Dashboard page logic
│   └── api/                # Firebase config, auth service
```

---

## QR Generator Flow (qr-generator.html)

### Purpose
Displayed on the yard office TV. A QR code is always showing and auto-refreshes every **30 seconds**.

### Auth
Requires `qr_generator` role. Stored in `localStorage['userData']` as JSON with a `role` field. Non-qr_generator users are redirected to `index.html`.

### QR URL
Each new token triggers a QR encoding of:
```
https://sysu-web-5a25d.web.app?token=SYS-XXXXXXXXXXXX
```
Token format: `SYS-` + 13 random uppercase alphanumeric chars (e.g. `SYS-0L6SKCV592L`).
Display below the QR shows the raw token (e.g. `SYS-0L6SKCV592L`).

### QR Refresh
```js
setInterval(refreshQR, 30000);
// refreshQR() calls GET /api/qr/generate → updates the QR + token display
```

### Backend API (Railway — Node.js)
Base URL: `https://sysu-web-production.up.railway.app/api/qr`

#### `GET /api/qr/generate`
Generates a new QR token.

**Response (200):**
```json
{
  "success": true,
  "token": "SYS-0L6SKCV592L",
  "expiresAt": 1746789600000,
  "tokenExpiryMs": 300000
}
```

#### `GET /api/qr/verify?token=SYS-XXX`
Called by the scan-result page when a driver scans the QR via web browser.

**Response (200):** token valid → marks token as used
```json
{ "success": true, "message": "Token verified", "token": "SYS-XXX" }
```
**Response (404):** token not found
**Response (410):** expired or already used

#### `POST /api/qr/scan`
Called by the SYSU mobile app (Kotlin) when a driver scans the QR.
```json
{
  "token": "SYS-0L6SKCV592L",
  "driverId": "firebase-uid-xxx",
  "driverName": "Juan Dela Cruz"
}
```

**Response (200):** added to queue
```json
{ "success": true, "message": "Successfully joined the queue" }
```
**Response (410):** token expired or already used
**Response (400):** driver already in queue

---

## Firestore Data

### Collections Used

#### `qr_tokens` (created by backend)
| Field | Type | Description |
|-------|------|-------------|
| `token` | string | Primary key, e.g. `SYS-0L6SKCV592L` |
| `createdAt` | timestamp | Server-side creation time |
| `expiresAt` | number | Unix ms expiry time |
| `used` | boolean | Whether token has been scanned |

#### `queue` (created when a driver scans)
| Field | Type | Description |
|-------|------|-------------|
| `driverId` | string | Firebase UID of the driver |
| `driverName` | string | Display name of the driver |
| `token` | string | The QR token that was scanned |
| `entryTime` | timestamp | When the driver joined queue |
| `status` | string | `waiting` or `loading` |
| `isAssigned` | boolean | Whether assigned to a shipment |
| `position` | null | Reserved for queue position number |

### Firestore Rules
The `qr_tokens` and `queue` collections require authentication. The `users` collection stores driver profiles (only admin-readable for qr_generator role).

---

## Real-time: Driver Joining the Queue (QR Generator TV)

The QR Generator page listens to Firestore for new queue entries using `onSnapshot`:

```js
firebase.firestore().collection('queue')
  .orderBy('entryTime', 'desc')
  .limit(50)
  .onSnapshot(snap => { ... });
```

When a new document appears (snap.size increased), a **toast notification** appears on the TV screen showing the driver's name:
- Toast slides in from the right with a green checkmark
- Shows "New Driver Joined" + driver's display name
- Auto-dismisses after 4 seconds

---

## Deployment

### Frontend (Firebase Hosting)
```bash
cd frontend
npm run build          # Vite builds main dashboard
# qr-generator.html and scan-result.html are standalone — manually copy:
cp qr-generator.html public/
cp qr-generator.html dist/
firebase deploy --only hosting
```

### Backend (Railway)
```bash
cd backend
git add . && git commit -m "message" && git push
# Railway auto-deploys from the main branch
```

---

## Firebase Projects
| Environment | Project ID | Used By |
|-------------|-----------|---------|
| Admin Dashboard | `sysuadmin` | qr-generator.html, queue-management.html |
| Main Web App | `sysu-app` (env vars) | Vite-built index/dashboard (main.js) |

---

## Roles
| Role | Access |
|------|--------|
| `qr_generator` | qr-generator.html only |
| `Admin` / `Fleet Manager` | dashboard.html |
| `pending` / `inactive` | Blocked, pending approval overlay |