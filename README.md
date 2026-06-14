# SYSU Fleet Management Platform — System Documentation

> **What this is:** The authoritative source of truth for how the SYSU platform works, what each part does, and how everything fits together. Written for the whole team — backend, frontend, mobile (Kotlin), and operations.

---

## Architecture Overview

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│  Kotlin Mobile  │◄───────►│  Express Backend │◄───────►│      SAP        │
│  App (Driver)   │  SOCKET │  (Node.js)       │  HTTPS  │ (External OData)│
└─────────────────┘         └────────┬─────────┘         └─────────────────┘
                                     │
                          ┌──────────▼─────────┐
                          │                    │
                    ┌─────────────────────────────────┐
                    │          Firebase               │
                    │  (Auth + Firestore)             │
                    │  - users    - incidents         │
                    │  - drivers  - sap_assign        │
                    │  - qr_tokens - queue            │
                    └─────────────────────────────────┘
                          │
                    ┌─────┴───────────────────────────────────┐
                    │   Vite Frontend (SPA)                   │
                    │   ┌───────┐  ┌───────────┐  ┌────────┐  │
                    │   │ Login │  │ Dashboard │  │QR Gen  │  │
                    │   │ Page  │  │ (Leaflet) │  │        │  │
                    │   └───────┘  └───────────┘  └────────┘  │
                    │   + SAP Table + Fleet Tree              │
                    └─────────────────────────────────────────┘
```

### How the pieces talk to each other

| Connection           | Method              | Purpose                                            |
| -------------------- | ------------------- | -------------------------------------------------- |
| Frontend → Backend   | HTTP REST           | Auth (login/logout/signup), SAP shipment proxy     |
| Backend → SAP        | HTTPS OData         | Fetch shipment data (bypasses CORS)                |
| Frontend → Firebase  | Firebase SDK        | Auth state, user roles, driver profiles, incidents |
| Frontend → Backend   | Socket.IO           | Live driver location updates                       |
| Kotlin App → Backend | Socket.IO           | Driver sends location → backend broadcasts         |
| Backend → Frontend   | Socket.IO broadcast | Driver location/status pushed to all dashboards    |

**All data (users, drivers, queue, etc.) lives in Firebase Firestore** — no separate MySQL/Postgres database.

---

## Environments & URLs

| Environment    | Frontend                              | Backend / API                                  |
| -------------- | ------------------------------------- | ---------------------------------------------- |
| **Local dev**  | `http://localhost:5173`               | `http://localhost:3000`                        |
| **Production** | Firebase Hosting (`sysu-app.web.app`) | Railway (`sysu-web-production.up.railway.app`) |

**Frontend proxy:** During local dev, Vite proxies `/api/*` to `http://localhost:3000` so there are no CORS issues.

---

## Self-Hosting / VPS Migration

### Backend (.env) — Required Variables

To run the backend on your own VPS, set these environment variables:

```bash
# ── Server ────────────────────────────────────────────────────────────────
PORT=8080                    # Default port the Express server listens on
NODE_ENV=production
TRUST_PROXY=1               # Set to "1" if behind a reverse proxy (nginx)

# ── Firebase Admin SDK ────────────────────────────────────────────────────
FIREBASE_PROJECT_ID=sysu-web-5a25d
# Paste entire service-account.json as a single-line JSON string.
FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"sysu-web-5a25d",...}'

# ── SAP Integration ────────────────────────────────────────────────────────
SAP_URL=https://your-sap-odata-endpoint.com/sap/opu/odata/sap/

# ── CORS Allowlist ────────────────────────────────────────────────────────
# Comma-separated origins. Must include your Firebase Hosting URL.
ALLOWED_ORIGINS="https://sysu-web-5a25d.web.app,https://sysu-web-5a25d.firebaseapp.com"

# ── Rate Limiting (optional overrides) ────────────────────────────────────
# GLOBAL_LIMIT=200          # global 15min/IP (default: 200)
# AUTH_LIMIT=15              # /api/auth/* 15min/IP (default: 15)
# QR_LIMIT=30                # /api/qr/* 1min/IP (default: 30)
```

**Critical files to keep secret:** `FIREBASE_SERVICE_ACCOUNT_JSON` (contains Firebase private key). Never commit `.env` to git.

### Starting the Backend on VPS

```bash
cd backend
npm install --production
node src/server.js
```

Or with PM2 (recommended for production):

```bash
npm install -g pm2
pm2 start src/server.js --name sysu-backend
pm2 save
pm2 startup   # generates startup script for server reboot
```

### Port Reference

| Port | Service | Notes |
|------|---------|-------|
| 8080 | Backend API + Socket.IO | Default; configurable via `PORT` env var |
| 5173 | Frontend dev (Vite) | Local dev only, not exposed on VPS |
| 3000 | Backend local dev proxy | Vite dev proxy target, not a separate service |

### Frontend Production — Updating API URL

Before building for your own VPS, set the production API URL:

```bash
# frontend/.env.production
VITE_API_URL=https://your-vps-domain.com
VITE_SOCKET_URL=https://your-vps-domain.com
```

Then build: `cd frontend && npm run build && firebase deploy --only hosting` (point Firebase Hosting to your new domain, or serve `dist/` via nginx directly).

### Nginx (optional — if not using Railway)

If self-hosting the backend behind nginx:

```nginx
server {
    listen 443 ssl;
    server_name your-vps-domain.com;

    location / {
        root /var/www/sysu-app/dist;
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## User Roles & Access

Roles are stored in Firestore under each user's document (`users/{uid}` → `role` field).

| Role            | Description                                                                |
| --------------- | -------------------------------------------------------------------------- |
| `super_admin`   | Full access — dashboard, SAP view, driver management, user management      |
| `admin`         | Everything except User Management tab                                      |
| `fleet_manager` | Dashboard + SAP view + driver management only                              |
| `qr_generator`  | QR code generator page — drivers self-serve queue check-in via QR          |
| `pending`       | Just registered — cannot access dashboard, shown "pending approval" screen |
| `inactive`      | Account disabled — redirected to login                                     |

### Role Change Enforcement

If an admin changes a user's role while they are logged in, the dashboard detects it via Firestore real-time listener and triggers a **security overlay** that forces a reload.

---

## Frontend Entry Points

| File                         | Role                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `frontend/index.html`        | Login page (served at `/` by Firebase Hosting)                       |
| `frontend/dashboard.html`    | Main dashboard (served at `/dashboard.html`)                         |
| `frontend/qr-generator.html` | QR queue generator page (served at `/qr-generator.html`)             |
| `frontend/src/main.js`       | Bootstraps auth check; redirects unauthenticated users to index.html |

---

## Key Data Flows

### 1. Login Flow

```
User submits email/password
    → AuthService.login(email, pass)
        → Firebase Auth (signInWithEmailAndPassword)
            → Firestore users/{uid} document
                → Checks role field
                    → "pending"  → show pending overlay
                    → "inactive" → show error
                    → else       → redirect to dashboard.html
```

### 2. Live Driver Tracking (Real-time)

```
Kotlin App detects GPS change
    → socket.emit("updateLocation", { driverId, lat, lng, status, name })
        → Backend receives, broadcasts:
        → io.emit("update_admin_map", { driverId, lat, lng, status, name })
            → ALL connected dashboards receive event
                → updateMarker(driver) updates Leaflet map marker
                → _renderAll() refreshes fleet tree
```

**Payload shape:**

```js
{
  driverId: "string",   // Matches driver ID in Firestore
  lat: 14.5995,         // Latitude
  lng: 120.9842,        // Longitude
  status: "online",     // "online" | "delayed" | "offline"
  name: "Driver Name"
}
```

### 3. SAP Shipment Fetch

```
Dashboard loads
    → SAPService.fetchShipments()
        → GET http://localhost:3000/api/sap/shipments
            → Backend proxies to SAP OData endpoint
            → Returns cached data if < 60s old
        → Parses response.d.results
        → state.sapShipments = results
        → _renderSapTable() displays in dashboard
```

### 4. Driver Profile Save

```
User fills driver form → Submit
    → setDoc(doc(db, "drivers", id), { ...fields })
        → Firestore onSnapshot listener fires in dashboard
        → state.drivers updated
        → _renderDrivers() updates driver cards
```

### 5. QR Token Generation (Admin/Central)

```
Admin/operational system requests token
    → POST /api/qr/generate
        → Backend generates: crypto.randomBytes(12) → "SYS-XXXXXXXXXXXX"
        → Stores in Firestore qr_tokens/{token} with 5-min expiry
        → Returns token to caller
```

**Note:** QR token generation is unauthenticated — any caller can request tokens. Tokens are single-use, expire in 5 minutes, and are consumed when a driver scans them.

### 6. Driver QR Check-In Flow

```
Driver opens QR page (qr-generator.html)
    → initAuthGuard() checks localStorage for userData with qr_generator role
        → If valid → startApp() renders QR page
        → If missing → redirect to login page
    → QR page displays token via API call to backend
    → Driver scans QR with phone's browser
        → Phone calls POST /api/qr/verify?token=SYS-XXXXX
            → Backend checks: exists? used? expired?
            → Returns 200 + marks token used
        → Phone then calls POST /api/qr/scan with { token, driverId, driverName }
            → Adds driver to Firestore queue/{id} with status "waiting"
            → Shows toast confirmation
```

### 7. QR Generator Logout (Cross-App Sign-Out)

```
User clicks logout on qr-generator.html
    → localStorage.removeItem('userData')
    → window.location.href = 'https://sysu-web-5a25d.web.app/?logout=1'
        → index.js detects ?logout=1 BEFORE AuthService.subscribe runs
        → auth.signOut() called on Firebase Auth
        → localStorage cleared
        → Redirects to clean / URL
```

**Design:** QR generator uses a separate Firebase project config (sysuadmin) only for Firestore writes. Auth session lives in localStorage with qr_generator role. When logout is triggered from QR page, it redirects to the main app's login page with a signal, and the login page handles the actual Firebase sign-out. This avoids Firebase SDK initialization conflicts between the two Firebase projects.

---

## Database Schema

### MySQL — **Removed (May 2026)**

Backend previously used a MySQL `admin` table for backend auth. **All MySQL code has been removed** — the backend now uses Firebase exclusively for all data storage and authentication.

### Firestore Collections

| Collection             | What it stores                                      | Managed by                   |
| ---------------------- | --------------------------------------------------- | ---------------------------- |
| `users/{uid}`          | User profile, role, status, position, displayName   | Login page + user management |
| `drivers/{id}`         | Driver profiles (name, phone, plate, company, etc.) | Dashboard driver management  |
| `incidents/{id}`       | Incident reports per driver                         | Dashboard incident feature   |
| `sap_assignments/{id}` | Driver-to-dispatch assignment: driverId, driverName, truckPlate, truckCompany, assignedAt | Dashboard SAP view + fleet assignment flows |
| `qr_tokens/{token}`    | Single-use QR tokens with expiry (SYS-XXXXXXXXXXXX) | Backend QR controller        |
| `queue/{id}`           | Driver queue entries: driverId, name, status, time  | QR scan flow + dashboard     |

---

## Security Notes

- **SAP URL + credentials:** Stored in backend `.env` — never sent to frontend
- **Firebase credentials:** Backend uses `FIREBASE_SERVICE_ACCOUNT_JSON` env var (Railway) or `service-account.json` (local)
- **Authentication:** Firebase ID tokens verified by `protectRoute` middleware; Socket.IO connections authenticated on handshake
- **CORS:** Backend uses `ALLOWED_ORIGINS` env var — no wildcards with credentials allowed
  - Production origins: `https://sysu-web-5a25d.web.app`, `https://sysu-web-5a25d.firebaseapp.com`
- **Rate limiting:** Global (100/15min/IP), Auth (15/15min/IP), QR (30/1min/IP)
- **QR tokens:** Generate using `crypto.randomBytes(12)` — 96-bit entropy, single-use, 5-minute expiry
- **Security headers:** `helmet` middleware applies `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`
- **SAP SSL:** Certificate verification is always enabled — `rejectUnauthorized: true` always enforced
- **Body size:** All JSON bodies limited to 10KB via `express.json({ limit: '10kb' })`

> **QR routes are intentionally unauthenticated.** `/api/qr/generate`, `/api/qr/verify`, and `/api/qr/scan` accept requests without a token. This is by design — drivers self-serve the queue by scanning a QR code. The token replaces the need for driver authentication.
>
> **QR generator auth isolation.** `qr-generator.html` uses localStorage to store a `userData` profile with `qr_generator` role (written by the main app's login page). It does NOT use Firebase Auth directly for session state — instead it redirects logout signals to the main app, which calls `auth.signOut()`. This prevents Firebase SDK conflicts since the QR page uses a different Firebase project config (sysu) than the main app (sysuadmin).

---

## Key Files That Were Cleaned Up (May 2026)

| What was removed                                                  | Why                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------- |
| `backend/src/middleware/authMiddleware.js`                        | Unused — replaced by `protectRoute.js`                  |
| `frontend/src/api/envValidator.js`                                | Ghost file, never referenced                            |
| `frontend/src/models/envValidator.js`                             | Ghost file, never referenced                            |
| `dashboard.html`'s dead `_renderTable()` function                 | Dead feature — `liveScans` state was never populated    |
| Unused keyframes in `index.html` style block                      | Moved to `main.css` for clean separation                |
| `panelBody`, `treeArea`, `userSearch` IDs in dashboard.html       | IDs existed in HTML but zero JS ever referenced them    |
| `frontend/public/qr.html`, `frontend/qr.html`                     | Duplicate queue pages, never referenced                 |
| `frontend/public/scan-result.html`, `frontend/public/logout.html` | Deprecated queue pages, superseded by qr-generator.html |

---

## Recent Changes (May 10, 2026)

### QR Generator Auth Rewrite

The QR generator auth flow was completely rewritten to resolve a persistent logout loop caused by Firebase SDK initialization conflicts between the main app and the QR page (which used a different Firebase project config).

**Before:** `qr-generator.html` called `firebase.auth().signOut()` on its own named Firebase app instance, causing race conditions.

**After:** `qr-generator.html` uses a `localStorage` fast path for session state. Logout redirects to the main login page (`index.html`) with `?logout=1`, which calls `auth.signOut()` before `AuthService.subscribe` registers — eliminating the race condition.

### `controller/sapController.js` (singular) — SAP Proxy with Cache

> **Note:** `sapController.js` lives in `controller/` (singular). `qrController.js` and `userController.js` live in `controllers/` (plural). This naming inconsistency is noted — not planned for fix, low priority.

### New `qr_generator` Role

A new Firebase role `qr_generator` routes users directly to `qr-generator.html` instead of the main dashboard. This allows drivers to access the QR queue without admin/dashboard permissions.

### User Role Updates

- Role changes now write `forceRefresh: Date.now()` to the Firestore user document, which the dashboard detects to trigger a security overlay
- `position` field is now set on every role change (Admin, Fleet Manager, Super Admin, Pending Approval, QR Generator)
- Users with `status: inactive` are now properly gated at login with clear messaging

---

## Related Documentation

- [Frontend Details](frontend/README.md) — Component breakdown, auth flow, each service explained
- [Backend Details](backend/README.md) — API endpoints, database details, Socket.IO
- [Driver App Details](KOTLIN_APP.md) — Kotlin Native Android app spec — auth, QR scanning, queue check-in, real-time location sharing
