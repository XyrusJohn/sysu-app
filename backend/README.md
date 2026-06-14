# SYSU Backend — Feature & Code Documentation

> **What this is:** Detailed breakdown of every piece of the Node.js/Express backend — what each file does, what the API endpoints are, and how it connects to SAP, Firebase, and the mobile app. For anyone working on the API, database, or WebSocket layer.

**Stack:** Node.js 18+, Express 5, Firebase Admin SDK, CommonJS
**Auth:** Firebase ID tokens (frontend logs in via Firebase Auth; backend verifies tokens with Firebase Admin SDK)
**Last verified:** May 2026

---

## Architecture

```
Frontend (Firebase Auth login)
    ↓ HTTP + Firebase token
Express Backend ← Firebase Admin SDK verifies tokens
    ↓
Routes: /api/auth/*, /api/sap/*, /api/users/*, /api/qr/*
    ↓
Socket.IO ← Firebase token verified on handshake
    ↓
Kotlin Mobile App (driver location updates)
```

All data lives in **Firebase Firestore only** — no MySQL, no separate SQL database.

---

## File Map

```
backend/src/
├── server.js              # Entry point — Express app, middleware, Socket.IO, routes
├── config/
│   └── firebase.js        # Firebase Admin SDK initialization
├── routes/
│   ├── authRoute.js       # /api/auth/* (role management — protected)
│   ├── sapRoute.js        # /api/sap/* (SAP OData proxy)
│   ├── userRoute.js       # /api/users/* (auth check — protected)
│   └── qrRoute.js         # /api/qr/* (QR token generate/verify/scan)
└── controllers/
    ├── userController.js  # Role update + user delete via Firestore
    └── qrController.js    # QR token generation, verify, scan via Firestore
    └── sapController.js   # SAP OData fetch + server-side cache
```

**Note:** `config/utils.js` (JWT utils) was removed when MySQL auth was removed. `models/userModel.js` and `config/db.js` (MySQL) were also removed.

---

## `server.js` — Application Bootstrap

**Purpose:** Sets up Express, applies global middleware, registers routes, starts Socket.IO, and begins listening.

```js
// src/server.js — simplified structure

// 1. Helmet security headers (applied to ALL responses)
app.use(helmet({ contentSecurityPolicy: false }));

// 2. Rate limiters
app.use(globalLimiter);    // 100 req / 15 min / IP — all routes
// authLimiter: 15 req / 15 min / IP — /api/auth/*
// qrLimiter: 30 req / 1 min / IP — /api/qr/*

// 3. CORS — origin allowlist via ALLOWED_ORIGINS env var
app.use(corsMiddleware);
// Credentials require explicit origin match (no wildcard)

// 4. Body parser (10KB max) + request logger
app.use(express.json({ limit: "10kb" }));

// 5. Routes
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/sap", sapRoutes);
app.use("/api/users", userRoutes);
app.use("/api/qr", qrLimiter, qrRoutes);

// 6. Health check
app.get("/api/health", (req, res) => res.send("OK"));

// 7. Socket.IO (auth on handshake — Firebase token verification)
const io = new Server(server, { cors: { origin: allowedOriginsList, credentials: true } });
io.use(async (socket, next) => { /* Firebase token verification */ });
io.on("connection", (socket) => {
  socket.on("driver_moving", (data) => {
    if (socket.user.uid !== data.driverId) return; // driver can only update themselves
    io.emit("update_admin_map", data);
  });
});

// 8. Graceful shutdown
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

---

## API Reference

### `GET /api/auth/check` — Verify Token

Protected endpoint — requires a valid Firebase ID token. Returns the authenticated user's info from the decoded Firebase token.

**Headers:** `Authorization: Bearer <firebase_id_token>`

**Response (200):**

```json
{
  "success": true,
  "message": "Authentication successful",
  "data": {
    "user_id": "firebase_uid_string",
    "email": "user@example.com"
  }
}
```

**Response (401):**

```json
{ "message": "Not authorized" }
```

---

### `POST /api/auth/update-role` — Change User Role

Protected (`super_admin` or `admin` only). Updates a user's Firestore document with a new role.

**Headers:** `Authorization: Bearer <firebase_id_token>`

**Request:**

```json
{
  "uid": "firebase_user_uid",
  "role": "fleet_manager"
}
```

**Valid roles:** `admin`, `fleet_manager`, `pending`, `super_admin`

**Role restrictions:**
- Only `super_admin` can promote users to `super_admin`
- `qr_generator` role is assigned by the system when a QR generator account is created

**Response (200):**

```json
{ "success": true, "message": "User role updated successfully" }
```

**Response (403):** `{ "message": "Forbidden: Insufficient permissions to change roles" }`

---

### `POST /api/auth/delete` — Delete User

Protected (`super_admin` only). Permanently deletes user data from Firestore.

**Headers:** `Authorization: Bearer <firebase_id_token>`

**Request:**

```json
{ "uid": "firebase_user_uid" }
```

**Response (200):**

```json
{ "success": true, "message": "User deleted successfully" }
```

---

### `GET /api/sap/shipments`

Fetches shipment data from the SAP OData endpoint and proxies it to the frontend. Response is cached server-side for **60 seconds**.

**Query params** (optional):

- `$top=100` — number of records
- `$orderby=Planning_Date desc` — sorting

**Response (200):**

```json
{
  "success": true,
  "data": {
    "d": {
      "results": [
        {
          "ShipmentID": "SHP-001",
          "Planning_Date": "/Date(1746307200000)/",
          "Route": "Metro Manila → Luzon",
          "Status": "Open"
        }
      ]
    }
  },
  "cached": false,
  "fetchedAt": "2026-05-04T00:00:00.000Z"
}
```

---

### `POST /api/qr/generate` — Generate QR Token (Unauthenticated)

Generates a single-use QR token. No auth required — any caller can request one (rate limited to 30/minute).

**Response (200):**

```json
{
  "success": true,
  "token": "SYS-A1B2C3D4E5F6",
  "expiresAt": 1746966000000,
  "tokenExpiryMs": 300000
}
```

**Token format:** `SYS-` + 24 uppercase hex characters (96-bit entropy from `crypto.randomBytes(12)`)
**Expiry:** 5 minutes

---

### `GET /api/qr/verify?token=SYS-XXXXX` — Verify QR Token (Unauthenticated)

Verifies a scanned QR token. Called by the driver's phone browser when scanning a QR code.

**Response (200):** `{ "success": true, "message": "Token verified", "token": "SYS-A1B2..." }`
**Response (404):** Token not found
**Response (410):** Token already used or expired

After a successful verification, the token is marked as `used: true` in Firestore.

---

### `POST /api/qr/scan` — Add Driver to Queue (Unauthenticated)

Called after token verification succeeds. Adds the driver to the Firestore `queue` collection.

**Request:**

```json
{
  "token": "SYS-A1B2C3D4E5F6",
  "driverId": "drv_001",
  "driverName": "Juan dela Cruz"
}
```

**Response (200):** `{ "success": true, "message": "Successfully joined the queue" }`
**Response (400):** Driver already in queue
**Response (410):** Token expired or already used

---

## `middleware/protectRoute.js` — Firebase Token Verification

Every protected route goes through this first. It verifies the Firebase ID token from the `Authorization: Bearer <token>` header.

```js
// src/middleware/protectRoute.js
const protectRoute = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader.split(" ")[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (err) {
    res.status(401).json({ message: "Not authorized" });
  }
};
```

**Error cases handled:**
- No Authorization header → 401 "Not authorized"
- Invalid token → 401 "Not authorized"
- Expired token → 401 "Not authorized"

---

## `config/firebase.js` — Firebase Admin Init

**Purpose:** Initializes the Firebase Admin SDK so the backend can verify Firebase tokens and write to Firestore.

```js
// src/config/firebase.js — initialization priority
initializeFirebase();

if (process.env.FIREBASE_CONFIG_JSON) {
  // Railway/Docker: Use env var directly (JSON string)
  const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
  credential = admin.credential.cert(serviceAccount);
} else if (fs.existsSync(serviceAccountPath)) {
  // Local dev: Use service-account.json file
  credential = admin.credential.cert(serviceAccountPath);
} else {
  // Fallback: Application Default Credentials (GCP metadata)
  credential = admin.credential.applicationDefault();
}
```

**Important:** Firebase init handles silent failure — if init fails, the server still boots, but Firebase-dependent routes will error gracefully.

---

## `controllers/sapController.js` — SAP Proxy with Cache

```js
// src/controller/sapController.js
let sapCache = { data: null, timestamp: 0 };
const CACHE_TTL = 60000; // 60 seconds

const getSapData = async (req, res) => {
  if (sapCache.data && now - sapCache.timestamp < CACHE_TTL) {
    return res.json({ success: true, data: sapCache.data, cached: true });
  }

  const response = await axios.get(process.env.SAP_URL, {
    httpsAgent: agent,
    params: { $top: 100, $orderby: "Planning_Date desc" },
  });

  sapCache = { data: result, timestamp: now };
  return res.json({ success: true, data: result });
};
```

**Important design decisions:**
- `httpsAgent` uses `rejectUnauthorized: true` always enforced
- Caching prevents hammering SAP on every dashboard refresh
- `SAP_URL` must be set in `.env` — the endpoint is a full OData URL

---

## `controllers/userController.js` — Firestore Role Management

```js
// src/controllers/userController.js
// updateUserRole — verifies caller is admin/super_admin, then writes to Firestore
// deleteUser — verifies caller is super_admin, then deletes from Firestore
```

Role hierarchy enforcement:
- `super_admin` can do everything
- `admin` can change roles EXCEPT assign `super_admin`
- `fleet_manager`, `qr_generator`, `pending` cannot access these endpoints

Role change also writes a `forceRefresh: Date.now()` field so the dashboard can detect it and trigger a security overlay.

---

## `controllers/qrController.js` — QR Token Management via Firestore

Collections: `qr_tokens` (tokens), `queue` (driver queue entries)

```js
// Token: crypto.randomBytes(12).toString("hex") → SYS-XXXXXXXXXXXXXXXXXXXXXXXX
// Stored in qr_tokens/{token} with expiresAt and used flag
// Consumed on verify (marked used immediately)
// Added to queue/{id} on scan with driverId, driverName, status: "waiting"
```

---

## Socket.IO — Real-time Driver Tracking

```js
// src/server.js
io.on("connection", (socket) => {
  console.log("📡 Connected:", socket.id);

  socket.on("driver_moving", (data) => {
    // Verifies sender is the driver they claim to be
    if (socket.user.uid !== data.driverId) return;
    io.emit("update_admin_map", data); // Broadcasts to ALL connected clients
  });
});
```

**Incoming event from Kotlin app:**

```json
{
  "driverId": "drv_001",
  "lat": 14.5995,
  "lng": 120.9842,
  "status": "online",
  "name": "Juan dela Cruz"
}
```

**Broadcast to all WebSocket clients:**

```json
{
  "driverId": "drv_001",
  "lat": 14.5995,
  "lng": 120.9842,
  "status": "online",
  "name": "Juan dela Cruz"
}
```

**Note:** `vendor_status_update` is defined as a constant in the frontend (`EVENTS.STATUS_UPDATE`) but **the backend does not emit it**. The Kotlin app's status field is carried within the `updateLocation` payload and the frontend reads `data.status` directly.

---

## Deployment Notes

| Concern | How it's handled |
| ------- | --------------- |
| CORS | `ALLOWED_ORIGINS` env var (comma-separated list); no wildcards |
| SAP SSL | `rejectUnauthorized: true` always enforced — no toggle |
| Firebase credentials | `FIREBASE_CONFIG_JSON` env var (Railway) or `service-account.json` |
| Rate limiting | `globalLimiter` (100/15min), `authLimiter` (15/15min), `qrLimiter` (30/1min) |
| Body size limits | `express.json({ limit: "10kb" })` |
| Graceful shutdown | SIGTERM/SIGINT handlers close server + Socket.IO cleanly |

**Production URL:** `https://sysu-web-production.up.railway.app`

---

## Security Notes

- **Helmet middleware** applies `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, HSTS, and other standard security headers
- **Role values** are validated against `['admin', 'fleet_manager', 'pending', 'super_admin']` in `updateUserRole` — arbitrary strings are rejected with `400`
- **Firebase token verification** protects: `/api/auth/*`, `/api/users/*`
- **QR routes** (`/api/qr/*`) are **intentionally open** — drivers self-authenticate by possessing a valid single-use token
- **Socket.IO** requires a valid Firebase ID token on handshake; drivers can only emit `driver_moving` for their own `driverId`
- See [`SECURITY.md`](https://github.com/your-org/sysu-web/blob/main/SECURITY.md) for full vulnerability disclosure and remediation status