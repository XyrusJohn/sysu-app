# SYSU Backend — Feature & Code Documentation

> **Review status (2026-10-15):** This guide contains historical examples. Only the route wiring and QR contract have been reconciled in this pass; other endpoint examples, file descriptions, and deployment details remain unverified. The current route source, tests, and [fix tracker](FIX_TRACKER.md) define live contracts.

> **What this is:** Detailed breakdown of every piece of the Node.js/Express backend — what each file does, what the API endpoints are, and how it connects to SAP, Firebase, and the mobile app. For anyone working on the API, database, or WebSocket layer.

**Stack:** Node.js 24 (manifest), Express 5, Firebase Admin SDK, CommonJS
**Auth:** Firebase ID tokens (frontend logs in via Firebase Auth; backend verifies tokens with Firebase Admin SDK)
**Last comprehensive verification:** May 2026; selected route review: 2026-10-15

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

### `POST /api/sap/dispatch-details`

Protected by Firebase authentication and active `fleet_manager`, `admin`, or `super_admin` authorization. Accepts 1–100 dispatch keys. The backend returns the whitelisted SAP line fields only for existing `sap_assignments` and OBD numbers present in each assignment. This restores staff dashboard details for assigned shipments while leaving the driver-readable assignment document unchanged. Responses use `Cache-Control: no-store`.

**Request:** `{"dispatchKeys":["0010136559"]}`

**Response data:** a dispatch-keyed object whose values are arrays of matching OBD rows, including route/planning dates, amount, volume, weight, Ship-To, address, and coordinates. Unknown or unassigned dispatch keys are omitted.

### `POST /api/sap/assign` — Create a driver assignment

The backend verifies each OBD, quantity, and customer against the current SAP dispatch before creating an assignment. The canonical driver-readable `lineItems` also include SAP-verified Ship-To, address, coordinates, volume, and weight when available. Amount is explicitly forbidden. Missing destination identity remains missing, so the mobile app must not merge those rows.

---

### QR endpoints — current route contract reviewed 2026-10-15

| Method and path | Access | Behavior |
| --- | --- | --- |
| `GET /api/qr/generate` | Public | Issues a QR token. |
| `GET /api/qr/verify` | Public | Checks token validity without consuming it. |
| `GET /api/qr/queue-display` | Public | Returns a bounded public queue projection. |
| `GET /api/qr/queue-cards` | Authenticated `admin`, `super_admin`, or `qr_generator` | Returns authorized queue-card details. |
| `POST /api/qr/scan` | Authenticated `driver` | Validates driver identity and admits the driver transactionally. |
| `PATCH /api/qr/queue-status` | Authenticated `admin` or `super_admin` | Updates queue status. |

Token issuance uses cryptographic random bytes and a 48-hour expiry. Verification is read-only; admission consumes the token. These details are supported by [the QR route](../backend/src/routes/qrRoute.js), [controller](../backend/src/controllers/qrController.js), and [QR regression tests](../backend/tests/unit/qrAndErrors.test.js). Recheck them when changing the route contract.

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

## Historical deployment examples — not revalidated

| Concern | How it's handled |
| ------- | --------------- |
| CORS | `ALLOWED_ORIGINS` env var (comma-separated list); no wildcards |
| SAP SSL | `rejectUnauthorized: true` always enforced — no toggle |
| Firebase credentials | See current backend Firebase configuration and deployment environment |
| Rate limiting | See `backend/src/config/runtime.js` and `backend/src/server.js`; older values in this guide are obsolete |
| Body size limits | `express.json({ limit: "10kb" })` |
| Graceful shutdown | SIGTERM/SIGINT handlers close server + Socket.IO cleanly |

## Security and deployment references

This section was not comprehensively reconciled. Consult [SECURITY.md](../SECURITY.md), the actual route/middleware source, [runtime configuration](../backend/src/config/runtime.js), and deployment-specific evidence. This guide makes no claim about current deployed settings or advisory status.
