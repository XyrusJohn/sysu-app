# SYSU Frontend — Feature & Code Documentation

> **Review status (2026-10-15):** Historical code guide; only build entry points and routing/development configuration were sampled in this pass. Verify other file descriptions against current source before relying on them.

> **What this is:** Detailed breakdown of every piece of the frontend — what it does, how it works, and what each file is responsible for. For anyone touching the UI, API integration, or dashboard logic.

**Last comprehensive verification:** May 2026 (post cleanup); selected configuration review: 2026-10-15
**Stack:** Vite 8, JavaScript ES modules, Tailwind CSS 4, Firebase SDK, Socket.IO Client, and Leaflet; React packages are declared, but React usage was not audited here.

---

## File Map

```
frontend/
├── index.html              # Login page (full HTML + inline SVG map animation)
├── dashboard.html          # Main dashboard (full HTML, ~1200 lines)
├── src/
│   ├── main.js             # Auth gatekeeper — checks session, redirects if unauthorized
│   ├── api/
│   │   ├── firebase.js     # Firebase app init — auth + firestore
│   │   ├── authService.js   # Login, Google login, logout, subscribe to auth state
│   │   ├── sapService.js    # Fetch SAP shipments, subscribe to Firestore assignments
│   │   └── socket.js        # Socket.IO client — connects to backend for live tracking
│   ├── components/
│   │   └── MapManager.js    # Leaflet map init, marker management, flyTo
│   ├── pages/
│   │   ├── index.js         # Login page interactivity (submit, Google, registration)
│   │   └── dashboard.js     # Main dashboard class — all views, sorting, drivers, SAP
│   └── style/
│       ├── main.css         # Tailwind @import + all custom tokens, keyframes, components
│       └── main.css         # Same filename — all custom CSS lives here
└── public/
    └── SYSU.png             # App icon
```

---

## `main.js` — Auth Gatekeeper

**Purpose:** Every page load runs through this. It checks if the user is authenticated and redirects them to `index.html` if not.

**Does NOT run on the login page** (`index.html`) — it's conditionally blocked there.

```js
// src/main.js
import { AuthService } from "./api/authService.js";

const initApp = async () => {
  const path = window.location.pathname;
  const isLoginPage = path === "/" || path.includes("index.html");

  if (isLoginPage) return;  // Skip auth check on login page

  try {
    const result = await AuthService.check();
    localStorage.setItem("userData", JSON.stringify(result.data));
  } catch (error) {
    console.error("Auth check failed:", error);
    window.location.href = "/index.html";  // Redirect if not logged in
  }
};

initApp();
```

---

## `api/firebase.js` — Firebase Initialization

**Purpose:** Sets up the Firebase app used by Auth and Firestore across the entire frontend. Config values must match your Firebase project (`sysu-app`).

```js
// src/api/firebase.js
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
```

**How it's used:**
- `authService.js` imports `auth` and `googleProvider`
- `dashboard.js` imports `db` for Firestore reads
- `index.js` imports `db` for user registration

---

## `api/authService.js` — Authentication

**Purpose:** All auth operations — email/password login, Google popup login, logout, and a real-time auth state subscriber.

```js
// src/api/authService.js — key exports
export const AuthService = {
  // Email/password login
  login: async (email, password) => {
    await setPersistence(auth, browserLocalPersistence);
    return signInWithEmailAndPassword(auth, email, password);
  },

  // Google popup login
  loginWithGoogle: async () => signInWithPopup(auth, googleProvider),

  // One-time token check (used by main.js gatekeeper)
  check: () => {
    return new Promise((resolve, reject) => {
      const unsubscribe = AuthService.subscribe((user, error) => {
        unsubscribe();
        if (error) reject(error);
        else resolve({ data: user });
      });
    });
  },

  // Real-time auth + role listener
  subscribe: (callback) => {
    return onAuthStateChanged(auth, async (user) => {
      // Reads the Firestore users/{uid} document for role
      // Fires callback(profile) whenever auth state OR role changes
      // Sets req.user.roleChanged = true if role was modified while logged in
    });
  },

  logout: async () => {
    await signOut(auth);
    localStorage.removeItem("userData");
    window.location.href = "/";
  }
};
```

**Role enforcement flow:**
1. User logs in → `subscribe()` fires with the Firebase user
2. `subscribe()` reads `users/{uid}` from Firestore (real-time via `onSnapshot`)
3. If the role changed while logged in (detected by comparing `currentUserProfile.role !== profile.role`), it sets `profile.roleChanged = true`
4. Dashboard sees `roleChanged` → calls `triggerSecurityEnforcement()` → shows overlay → reloads

---

## `api/sapService.js` — SAP Integration

**Purpose:** Fetches shipment data from the backend proxy (the backend, not directly from SAP — to bypass CORS). It also subscribes to `sap_assignments` in Firestore.

```js
// src/api/sapService.js
const PROD_API = "https://sysu-web-production.up.railway.app/api/sap/shipments";
const DEV_API  = "http://localhost:3000/api/sap/shipments";
const SAP_API_URL = import.meta.env.PROD ? PROD_API : DEV_API;

export const SAPService = {
  state: {
    shipments: [],      // Array of SAP shipment objects
    assignments: {},     // { shipmentId: { driverName, ... } }
    lastUpdated: null,
  },

  // Fetches from GET /api/sap/shipments
  // Returns: array of shipment objects (parsed from response.d.results)
  async fetchShipments() {
    const response = await fetch(SAP_API_URL);
    const json = await response.json();
    const sapData = json.data?.d?.results ?? json.data?.results ?? json.data;
    this.state.shipments = sapData;
  },

  // Subscribes to Firestore sap_assignments collection
  // callback(data) called whenever assignments change
  subscribeToAssignments(callback) { ... },

  // Parses SAP /Date(123456789000)/ format into readable date
  parseDate(sapDate) { ... }
};
```

---

## `api/socket.js` — Live Tracking Client

**Purpose:** Connects the frontend to the backend via WebSocket (Socket.IO). Used by the dashboard to receive live driver location updates broadcasted from the Kotlin app.

```js
// src/api/socket.js
import { io } from "socket.io-client";

const PROD_URL = "https://sysu-web-production.up.railway.app";
const SOCKET_URL = import.meta.env.PROD ? PROD_URL : "http://localhost:3000";

export const socket = io(SOCKET_URL, {
  autoConnect: true,
  reconnection: true,
});

export const EVENTS = {
  DRIVER_MOVING: "update_admin_map",   // Driver location update
  STATUS_UPDATE: "vendor_status_update", // Status change (defined but not emitted by backend)
};
```

---

## `components/MapManager.js` — Leaflet Map

**Purpose:** Manages the Leaflet map instance and driver markers. Uses dark CartoDB tiles.

```js
// src/components/MapManager.js
export const initLeafletMap = (containerId) => { ... };
// -> Initializes Leaflet on containerId, dark tiles, Manila center [14.5995, 120.9842]
// -> Returns the map instance (stored as window.map)

export const updateMarker = (driver) => { ... };
// -> Adds or moves a driver marker on the map
// -> Color: green = online, gold = delayed, red = incident/offline
// -> Clicking a driver in fleet tree calls focusOnLocation()

export const focusOnLocation = (lat, lng) => { ... };
// -> map.flyTo(lat, lng, zoom 14, 1.5s animation)

export const clearMarkers = () => { ... };
// -> Removes all driver markers from map
```

**Leaflet tile URL:** `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`

---

## `pages/dashboard.js` — Main Dashboard Class

**Purpose:** The entire dashboard is one JavaScript class `Dashboard` containing all state and rendering logic.

**Entry point:** `dashboard.html` loads `main.js` → auth passes → creates `new Dashboard().init()`

### State:
```js
this.state = {
  activeView: "overview",       // Current nav view
  sapShipments: [],             // From SAP (via sapService)
  sapAssignments: {},           // From Firestore
  sapSortKey: "Planning_Date",  // SAP table sort column
  sapSortDir: -1,               // Sort direction (-1 = desc)
  user: null,                   // Current user profile
  drivers: [],                  // From Firestore drivers collection
  incidents: [],               // From Firestore incidents collection
  liveTracking: {},            // Live driver data keyed by driverId
  sapFilter: "all",            // SAP table filter
};
```

### Views (all triggered by nav button clicks):
| View | Render Function | What's shown |
|---|---|---|
| `overview` | `_renderAll()` | Map + SAP table + Fleet tree |
| `orders` | `_renderSapTable()` | Full SAP shipment table |
| `drivers` | `_renderDrivers()` | Driver cards grid |
| `docs` | N/A | Static HTML in dashboard.html |
| `users` | N/A | User management (admin only) |
| `settings` | N/A | Settings panel (admin only) |

### `_renderDrivers()` — Driver Cards
- Fetches `drivers` from Firestore
- Merges with `liveTracking` data (socket data) for online/offline status
- Displays incident indicators — `hasIncident` checks `state.incidents`
- Green pulse = online, red dot = offline
- Click card → opens edit modal

### `_renderSapTable()` — SAP Shipment Table
- Renders `state.sapShipments` in a sortable/searchable table
- Filter tabs: All / Open / Transit / Delivered / Unassigned
- Sort by column header click
- Search input filters across all text fields
- Empty state if no results

### `_renderFleetTree()` — Left Sidebar Fleet List
- Groups drivers by `truckingCompany` (or "Internal Fleet")
- Shows online/offline indicator dot
- Click driver name → `focusOnLocation()` on map

---

## `pages/index.js` — Login Page Logic

**Handles:**
1. Email/password login with validation
2. Google popup login
3. Pending registration flow (shown after successful signup if role is "pending")
4. Registration modal flow (shown after signup if Firestore user doc doesn't exist yet)
5. Slide carousel (3 slides of feature highlights)
6. Animated stat counters (Trucks: 47, Deliveries: 138, Uptime: 99%)
7. Password visibility toggle
8. Remember me (no-op in current code, `rememberMe` is unused)
9. Forgot password (shows message, not functional — needs Firebase config)

---

## `style/main.css` — Tailwind + Custom CSS

**Tailwind v4 entry point:**
```css
@import "tailwindcss";
```

**Custom theme tokens defined via `@theme`:**
```css
@theme {
  --color-sysu-red: #c8102e;
  --color-sysu-gold: #f5a623;
  --color-sysu-dark: #060608;
  --color-db-bg: #15171a;
  --color-db-rail: #1c1e21;
  --color-db-panel: #1c1e21;
  --color-db-border: #2d3035;
  --color-db-text: #f0f0f0;
  --font-display: "Syne", sans-serif;
  --font-body: "DM Sans", sans-serif;
}
```

**Key custom classes in `@layer components`:**
- `.btn-login` / `.btn-google` — styled login buttons
- `.input-field` — styled form inputs with focus ring
- `.alert-msg` — error/success messages
- `#regOverlay` / `#pendingOverlay` — fixed fullscreen modals with show/hide
- `.drv-card-premium` — driver card with hover effect; `.has-incident` adds pulsing red border

**Key `@keyframes`:**
- `truck1-anim`, `truck2-anim`, `truck3-anim` — login page truck path animations (SVG overlay on login page)
- `pulse-dot` — map marker pulse animation
- `dash-flow` — animated dashed route lines on login SVG
- `incident-pulse` — red pulsing border for driver cards with incidents
- `fadeIn`, `slideUp`, `spin` — UI transitions

---

## Routing & Deploy

**Frontend delivery:** `frontend/vite.config.js` builds multiple HTML entry points. The backend entry point inspected in this audit does not configure `express.static()`; do not rely on this guide's historical same-origin deployment description.

**Firebase Hosting:** In the standard setup, Firebase Hosting serves the frontend separately. The `firebase.json` specifies `public: "dist"` — so `dist/` must be built before deploying.

**Vite proxy (local dev):** `/api/*` and `/socket.io` use the origins resolved by `src/api/releaseConfig.js`. Local mode requires explicit loopback URLs and a demo Firebase project; see [release configuration](../frontend/src/api/releaseConfig.js).

---

## Firebase Auth & Firestore Connection

Authentication is **Firebase Auth** (not backend MySQL auth). The backend MySQL is used only for the admin panel's own users (a separate legacy system).

However, **Firebase Firestore** is the main data store for:
- User profiles (linked to Firebase Auth UID) with role
- Driver profiles
- Incidents
- SAP assignments

This means the dashboard's real-time features (driver updates, incident alerts) depend on Firestore listeners. The `authService.subscribe()` hook reads both Firebase Auth (for the user) and Firestore (for the role and profile).

---

## Known Gaps (Not Yet Implemented)

| Feature | Status | Notes |
|---|---|---|
| SAP assignment save | Partial | Frontend shows assignment modal but `saveAssignment()` only logs |
| User management CRUD | Partial | UI shows user list but only role delete implemented |
| Forgot password | UI message only | Needs Firebase Auth password reset config |
| Incident creation from dashboard | Not implemented | `incidents` array is displayed but no write path |
| `vendor_status_update` Socket event | Backend doesn't emit it | Kotlin app can't use this yet |
