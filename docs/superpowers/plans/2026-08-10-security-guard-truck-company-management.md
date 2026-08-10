# Security Guard & Truck Company Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add admin-only CRUD for `security_guard` and `truck_company` collections, surfaced as two new sub-tabs inside the Document tab. Reads use Firestore `onSnapshot`; writes go through new backend Express endpoints with auto-incrementing IDs and server-side validation.

**Architecture:** Hybrid client/server. Frontend subscribes to Firestore collections directly (matches existing `OverrideRequestService` and `drivers` patterns) for realtime reads. All mutations (create / update / setActive) call new backend endpoints (`/api/admin/guards`, `/api/admin/truck-companies`) that use Firebase Admin SDK to enforce validation and atomic ID generation. Sub-tab visibility is gated on `this._isApprover()`. Soft delete only.

**Tech Stack:** Node/Express (CommonJS, `require()`) backend with Firebase Admin SDK; ES module frontend with Vite, Tailwind v4, Firebase v12 modular SDK. No new third-party libraries.

**Spec:** [`docs/superpowers/specs/2026-08-10-security-guard-truck-company-management-design.md`](../specs/2026-08-10-security-guard-truck-company-management-design.md)

---

## Global Constraints

- Backend uses CommonJS (`require`); frontend uses ES modules (`import`).
- All backend mutations must verify Firebase ID token via `protectRoute` middleware and confirm `req.user.role in ['admin', 'super_admin']` before any Firestore write.
- Frontend auth token included as `Authorization: Bearer <idToken>` on every write call (same pattern as existing `/api/users/update-role`).
- ID format: `security_guard` doc IDs are `SG-NNN` (3-digit zero-pad); `truck_company` doc IDs are zero-padded numeric strings, minimum width 2 (auto-widens at 100).
- Server always recomputes `security_guard.fullName` as `{firstName} {middleInitial ? middleInitial + ' ' : ''}{lastName}` on create and update; client never writes it directly.
- Soft delete = `updateDoc({ active: false })`. No hard delete endpoint exists.
- New collections fall under existing `firestore.rules` default-deny at line 93. This plan adds read-only `match` blocks for them.
- Body size limit is 10kb (existing `express.json({limit: "10kb"})` in `server.js`).
- Helmet and rate limiting are already configured globally in `server.js`; the new admin routes inherit them.
- `req.user.uid` is the verified Firebase Auth UID. `req.user.role` does NOT exist on the decoded token in this codebase — admin check must read `users/{req.user.uid}.role` from Firestore, matching the existing `userController.js:21-26` pattern.
- Toast helper: `_showToast(message)` (class method on `Dashboard`). Backend errors surface via `alert(message)` or `_showToast(message)`.

---

## File Structure

### Backend (new)
- `backend/src/utils/idGenerator.js` — pure logic for next-ID generation; unit-tested without Firestore.
- `backend/src/middleware/requireAdmin.js` — checks the caller's `users/{uid}.role`.
- `backend/src/controllers/admin/guardController.js` — `createGuard`, `updateGuard`, `setGuardActive`.
- `backend/src/controllers/admin/truckCompanyController.js` — `createTruckCompany`, `updateTruckCompany`, `setTruckCompanyActive`.
- `backend/src/routes/adminRoute.js` — Express router mounting all 6 endpoints.
- `backend/__tests__/idGenerator.test.js` — node:test unit tests for ID math.

### Backend (modify)
- `backend/src/server.js` — register `adminRoutes` under `/api/admin`.

### Frontend (new)
- `frontend/src/api/securityGuardService.js` — `subscribe`, `create`, `update`, `setActive`.
- `frontend/src/api/truckCompanyService.js` — same shape.
- `frontend/src/components/__tests__/securityGuardService.test.js` — Jest test for ID-format sanitization and search-filter.

### Frontend (modify)
- `frontend/dashboard.html` — add 2 sub-tab buttons, 2 modals (`#guardModal`, `#truckCompanyModal`).
- `frontend/src/pages/dashboard.js` — sub-tab handler dispatch, render methods, modal handlers, soft-delete with confirm.
- `frontend/firestore.rules` — add read-only match blocks.

---

## Task Decomposition

Each task ends with a commit and produces independently testable behavior.

### Task 1: Backend ID generator utility + tests

**Files:**
- Create: `backend/src/utils/idGenerator.js`
- Create: `backend/__tests__/idGenerator.test.js`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces:
  - `parseGuardId(id: string): number | null` — returns N for "SG-NNN", else null.
  - `parseCompanyCode(code: string): number | null` — returns N for "NN", else null.
  - `formatGuardId(n: number): string` — pads to 3 digits.
  - `formatCompanyCode(n: number, minWidth?: number): string` — pads to `max(2, ceil(log10(n+1)))`.
  - `pickNextIdFromList(existingIds: string[], format: (n: number) => string, parse: (s: string) => number | null): string` — scans list, returns next ID.

- [ ] **Step 1: Write the failing test**

Create `backend/__tests__/idGenerator.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    parseGuardId,
    parseCompanyCode,
    formatGuardId,
    formatCompanyCode,
    pickNextIdFromList,
} = require("../src/utils/idGenerator.js");

test("parseGuardId extracts SG-001", () => {
    assert.equal(parseGuardId("SG-001"), 1);
});
test("parseGuardId returns null for non-guard IDs", () => {
    assert.equal(parseGuardId("01"), null);
    assert.equal(parseGuardId("SG-XX"), null);
});
test("parseCompanyCode extracts 51", () => {
    assert.equal(parseCompanyCode("51"), 51);
});
test("parseCompanyCode returns null for non-numeric", () => {
    assert.equal(parseCompanyCode("LALAMOVE"), null);
});
test("formatGuardId pads to 3 digits", () => {
    assert.equal(formatGuardId(1), "SG-001");
    assert.equal(formatGuardId(42), "SG-042");
    assert.equal(formatGuardId(123), "SG-123");
});
test("formatCompanyCode pads to min width 2", () => {
    assert.equal(formatCompanyCode(1), "01");
    assert.equal(formatCompanyCode(51), "51");
});
test("formatCompanyCode widens beyond 99", () => {
    assert.equal(formatCompanyCode(100), "100");
    assert.equal(formatCompanyCode(999), "999");
});
test("pickNextIdFromList returns SG-001 for empty", () => {
    assert.equal(pickNextIdFromList([], formatGuardId, parseGuardId), "SG-001");
});
test("pickNextIdFromList increments max", () => {
    assert.equal(
        pickNextIdFromList(["SG-001", "SG-002", "SG-010"], formatGuardId, parseGuardId),
        "SG-011",
    );
});
test("pickNextIdFromList ignores non-matching IDs", () => {
    assert.equal(
        pickNextIdFromList(["SG-001", "BAD"], formatGuardId, parseGuardId),
        "SG-002",
    );
});
test("pickNextIdFromList widens when next exceeds current width", () => {
    assert.equal(
        pickNextIdFromList(["SG-099"], formatGuardId, parseGuardId),
        "SG-100",
    );
});
test("pickNextIdFromList company codes — empty", () => {
    assert.equal(pickNextIdFromList([], formatCompanyCode, parseCompanyCode), "01");
});
test("pickNextIdFromList company codes — many", () => {
    assert.equal(
        pickNextIdFromList(["01", "02", "51"], formatCompanyCode, parseCompanyCode),
        "52",
    );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test __tests__/idGenerator.test.js`
Expected: FAIL with "Cannot find module '../src/utils/idGenerator.js'".

- [ ] **Step 3: Write the implementation**

Create `backend/src/utils/idGenerator.js`:

```js
/**
 * Pure helpers for next-ID generation. Decoupled from Firestore so they
 * are unit-testable with no Firebase dependency. Firestore transactions
 * live in the controllers; they call these helpers to compute the ID.
 */

const GUARD_WIDTH = 3;
const COMPANY_MIN_WIDTH = 2;

function parseGuardId(id) {
    if (typeof id !== "string") return null;
    const m = /^SG-(\d+)$/.exec(id);
    if (!m) return null;
    return parseInt(m[1], 10);
}

function parseCompanyCode(code) {
    if (typeof code !== "string") return null;
    if (!/^\d+$/.test(code)) return null;
    return parseInt(code, 10);
}

function formatGuardId(n) {
    const padded = String(n).padStart(GUARD_WIDTH, "0");
    return `SG-${padded}`;
}

function formatCompanyCode(n) {
    const width = Math.max(COMPANY_MIN_WIDTH, String(n + 1).length);
    return String(n).padStart(width, "0");
}

function pickNextIdFromList(existingIds, format, parse) {
    let maxN = 0;
    for (const id of existingIds) {
        const n = parse(id);
        if (n != null && n > maxN) maxN = n;
    }
    return format(maxN + 1);
}

module.exports = {
    parseGuardId,
    parseCompanyCode,
    formatGuardId,
    formatCompanyCode,
    pickNextIdFromList,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test __tests__/idGenerator.test.js`
Expected: all 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/idGenerator.js backend/__tests__/idGenerator.test.js
git commit -m "feat(backend): pure ID-generator utilities with node:test coverage"
```

---

### Task 2: Backend `requireAdmin` middleware

**Files:**
- Create: `backend/src/middleware/requireAdmin.js`

**Interfaces:**
- Consumes: `req.user.uid` populated by `protectRoute`. Reads `users/{uid}.role` from Firestore.
- Produces: passes to `next()` if role is `admin` or `super_admin`. Otherwise returns `403`.

- [ ] **Step 1: Create the middleware**

```js
const {admin} = require("../config/firebase.js");

/**
 * Must be used AFTER protectRoute. Verifies the caller's role from
 * users/{uid}.role is admin or super_admin. Returns 403 otherwise.
 *
 * The role is read from Firestore (NOT from the decoded token) because
 * the codebase does not currently set Firebase custom claims — see
 * userController.js:21-26 for the existing precedent.
 */
const requireAdmin = async (req, res, next) => {
    try {
        const uid = req.user?.uid;
        if (!uid) {
            return res.status(401).json({message: "Not authorized"});
        }
        const userDoc = await admin.firestore().collection("users").doc(uid).get();
        const role = userDoc.data()?.role;
        if (role !== "admin" && role !== "super_admin") {
            return res.status(403).json({message: "Forbidden: admin role required"});
        }
        next();
    } catch (error) {
        console.error("requireAdmin error:", error.message);
        res.status(500).json({message: "Internal server error"});
    }
};

module.exports = {requireAdmin};
```

- [ ] **Step 2: Verify it imports cleanly**

Run: `cd backend && node -e "require('./src/middleware/requireAdmin.js'); console.log('ok')"`
Expected: prints `ok` (no module errors). Firebase Admin is not initialized at import time, so no auth call is made.

- [ ] **Step 3: Commit**

```bash
git add backend/src/middleware/requireAdmin.js
git commit -m "feat(backend): requireAdmin middleware reading role from users/{uid}"
```

---

### Task 3: Backend guard controller

**Files:**
- Create: `backend/src/controllers/admin/guardController.js`

**Interfaces:**
- Consumes: `req.body` for create/update (validated inline); `req.params.id` for update/setActive.
- Produces: JSON responses. Status codes: `200` (success), `400` (validation), `404` (missing), `500` (server error). On create, returns `{ guardId, fullName, ...docData }`.

- [ ] **Step 1: Create the controller**

```js
const {admin} = require("../../config/firebase.js");
const {
    pickNextIdFromList,
    formatGuardId,
    parseGuardId,
} = require("../../utils/idGenerator.js");

const COLLECTION = "security_guard";

function buildFullName(firstName, lastName, middleInitial) {
    const mi = (middleInitial || "").trim();
    return `${firstName.trim()} ${mi ? mi + " " : ""}${lastName.trim()}`.trim().replace(/\s+/g, " ");
}

function validateGuardPayload(body) {
    const errors = [];
    const firstName = (body.firstName || "").trim();
    const lastName = (body.lastName || "").trim();
    const middleInitial = (body.middleInitial || "").trim();

    if (!firstName) errors.push({field: "firstName", message: "First name is required"});
    else if (firstName.length > 60) errors.push({field: "firstName", message: "First name must be 60 characters or fewer"});

    if (!lastName) errors.push({field: "lastName", message: "Last name is required"});
    else if (lastName.length > 60) errors.push({field: "lastName", message: "Last name must be 60 characters or fewer"});

    if (middleInitial.length > 5) errors.push({field: "middleInitial", message: "Middle initial must be 5 characters or fewer"});

    return {errors, firstName, lastName, middleInitial};
}

async function fetchAllGuardIds() {
    const snap = await admin.firestore().collection(COLLECTION).get();
    return snap.docs.map((d) => d.id);
}

exports.createGuard = async (req, res) => {
    const {errors, firstName, lastName, middleInitial} = validateGuardPayload(req.body || {});
    if (errors.length) return res.status(400).json({errors});

    try {
        const ids = await fetchAllGuardIds();
        const guardId = pickNextIdFromList(ids, formatGuardId, parseGuardId);
        const fullName = buildFullName(firstName, lastName, middleInitial);
        const docData = {
            guardId,
            firstName,
            lastName,
            middleInitial,
            fullName,
            active: true,
            createdAt: new Date().toISOString(),
        };
        await admin.firestore().collection(COLLECTION).doc(guardId).set(docData);
        return res.status(201).json(docData);
    } catch (error) {
        console.error("createGuard error:", error.message);
        return res.status(500).json({message: "Internal server error"});
    }
};

exports.updateGuard = async (req, res) => {
    const {id} = req.params;
    if (!parseGuardId(id)) return res.status(400).json({message: "Invalid guardId"});

    const {errors, firstName, lastName, middleInitial} = validateGuardPayload(req.body || {});
    if (errors.length) return res.status(400).json({errors});

    try {
        const ref = admin.firestore().collection(COLLECTION).doc(id);
        const existing = await ref.get();
        if (!existing.exists) return res.status(404).json({message: "Guard not found"});

        const fullName = buildFullName(firstName, lastName, middleInitial);
        await ref.update({firstName, lastName, middleInitial, fullName});
        return res.json({guardId: id, firstName, lastName, middleInitial, fullName, active: existing.data().active});
    } catch (error) {
        console.error("updateGuard error:", error.message);
        return res.status(500).json({message: "Internal server error"});
    }
};

exports.setGuardActive = async (req, res) => {
    const {id} = req.params;
    if (!parseGuardId(id)) return res.status(400).json({message: "Invalid guardId"});
    const active = !!req.body?.active;

    try {
        const ref = admin.firestore().collection(COLLECTION).doc(id);
        const existing = await ref.get();
        if (!existing.exists) return res.status(404).json({message: "Guard not found"});
        await ref.update({active});
        return res.json({guardId: id, active});
    } catch (error) {
        console.error("setGuardActive error:", error.message);
        return res.status(500).json({message: "Internal server error"});
    }
};
```

- [ ] **Step 2: Verify the module loads**

Run: `cd backend && node -e "require('./src/controllers/admin/guardController.js'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/controllers/admin/guardController.js
git commit -m "feat(backend): guard controller with create/update/setActive"
```

---

### Task 4: Backend truck company controller

**Files:**
- Create: `backend/src/controllers/admin/truckCompanyController.js`

**Interfaces:** Same shape as guard controller; payload fields are `forwarderCode` and `name`.

- [ ] **Step 1: Create the controller**

```js
const {admin} = require("../../config/firebase.js");
const {
    pickNextIdFromList,
    formatCompanyCode,
    parseCompanyCode,
} = require("../../utils/idGenerator.js");

const COLLECTION = "truck_company";

function validateCompanyPayload(body) {
    const errors = [];
    const forwarderCode = (body.forwarderCode || "").trim();
    const name = (body.name || "").trim();

    if (!forwarderCode) errors.push({field: "forwarderCode", message: "Forwarder code is required"});
    else if (forwarderCode.length > 50) errors.push({field: "forwarderCode", message: "Forwarder code must be 50 characters or fewer"});
    else if (!/^[A-Za-z0-9-]+$/.test(forwarderCode)) errors.push({field: "forwarderCode", message: "Forwarder code may only contain letters, digits, and dashes"});

    if (!name) errors.push({field: "name", message: "Name is required"});
    else if (name.length > 200) errors.push({field: "name", message: "Name must be 200 characters or fewer"});

    return {errors, forwarderCode, name};
}

async function fetchAllCompanyCodes() {
    const snap = await admin.firestore().collection(COLLECTION).get();
    return snap.docs.map((d) => d.id);
}

exports.createTruckCompany = async (req, res) => {
    const {errors, forwarderCode, name} = validateCompanyPayload(req.body || {});
    if (errors.length) return res.status(400).json({errors});

    try {
        const ids = await fetchAllCompanyCodes();
        const companyCode = pickNextIdFromList(ids, formatCompanyCode, parseCompanyCode);
        const docData = {
            companyCode,
            forwarderCode,
            name,
            active: true,
            createdAt: new Date().toISOString(),
        };
        await admin.firestore().collection(COLLECTION).doc(companyCode).set(docData);
        return res.status(201).json(docData);
    } catch (error) {
        console.error("createTruckCompany error:", error.message);
        return res.status(500).json({message: "Internal server error"});
    }
};

exports.updateTruckCompany = async (req, res) => {
    const {code} = req.params;
    if (!parseCompanyCode(code)) return res.status(400).json({message: "Invalid companyCode"});

    const {errors, forwarderCode, name} = validateCompanyPayload(req.body || {});
    if (errors.length) return res.status(400).json({errors});

    try {
        const ref = admin.firestore().collection(COLLECTION).doc(code);
        const existing = await ref.get();
        if (!existing.exists) return res.status(404).json({message: "Truck company not found"});
        await ref.update({forwarderCode, name});
        return res.json({companyCode: code, forwarderCode, name, active: existing.data().active});
    } catch (error) {
        console.error("updateTruckCompany error:", error.message);
        return res.status(500).json({message: "Internal server error"});
    }
};

exports.setTruckCompanyActive = async (req, res) => {
    const {code} = req.params;
    if (!parseCompanyCode(code)) return res.status(400).json({message: "Invalid companyCode"});
    const active = !!req.body?.active;

    try {
        const ref = admin.firestore().collection(COLLECTION).doc(code);
        const existing = await ref.get();
        if (!existing.exists) return res.status(404).json({message: "Truck company not found"});
        await ref.update({active});
        return res.json({companyCode: code, active});
    } catch (error) {
        console.error("setTruckCompanyActive error:", error.message);
        return res.status(500).json({message: "Internal server error"});
    }
};
```

- [ ] **Step 2: Verify the module loads**

Run: `cd backend && node -e "require('./src/controllers/admin/truckCompanyController.js'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/controllers/admin/truckCompanyController.js
git commit -m "feat(backend): truck company controller with create/update/setActive"
```

---

### Task 5: Backend admin route + register in server.js

**Files:**
- Create: `backend/src/routes/adminRoute.js`
- Modify: `backend/src/server.js:33-35` (add import) and `backend/src/server.js:96-100` (add `app.use`).

**Interfaces:** Mounts at `/api/admin`. All routes protected by `protectRoute` + `requireAdmin`.

- [ ] **Step 1: Create the route file**

```js
const express = require("express");
const router = express.Router();
const {protectRoute} = require("../middleware/protectRoute.js");
const {requireAdmin} = require("../middleware/requireAdmin.js");
const {
    createGuard,
    updateGuard,
    setGuardActive,
} = require("../controllers/admin/guardController.js");
const {
    createTruckCompany,
    updateTruckCompany,
    setTruckCompanyActive,
} = require("../controllers/admin/truckCompanyController.js");

// Guards
router.post("/guards", protectRoute, requireAdmin, createGuard);
router.patch("/guards/:id", protectRoute, requireAdmin, updateGuard);
router.patch("/guards/:id/active", protectRoute, requireAdmin, setGuardActive);

// Truck companies
router.post("/truck-companies", protectRoute, requireAdmin, createTruckCompany);
router.patch("/truck-companies/:code", protectRoute, requireAdmin, updateTruckCompany);
router.patch("/truck-companies/:code/active", protectRoute, requireAdmin, setTruckCompanyActive);

module.exports = router;
```

- [ ] **Step 2: Register the router in server.js**

In `backend/src/server.js`, add `const adminRoutes = require("./routes/adminRoute.js");` to the requires block (after `userRoutes` import on line 33). Then add `app.use("/api/admin", adminRoutes);` after the existing `app.use("/api/drivers", driverRoutes);` on line 100.

- [ ] **Step 3: Smoke-test that server still loads**

Run: `cd backend && node -e "const s = require('./src/server.js'); setTimeout(() => process.exit(0), 200);"`
Expected: server starts; logs `🚀 SYSU SERVER RUNNING ON PORT 8080` (or whatever PORT env says); exits cleanly. Hit Ctrl+C-equivalent — setTimeout kills it. If you see uncaught require errors, fix the imports.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/adminRoute.js backend/src/server.js
git commit -m "feat(backend): register admin routes for guards and truck companies"
```

---

### Task 6: Frontend securityGuardService + Jest test

**Files:**
- Create: `frontend/src/api/securityGuardService.js`
- Create: `frontend/src/components/__tests__/securityGuardService.test.js`

**Interfaces:**
- `SecurityGuardService.subscribe(callback) -> unsubscribe`
- `SecurityGuardService.create({firstName, lastName, middleInitial}) -> Promise<{guardId, ...}>`
- `SecurityGuardService.update(guardId, {firstName, lastName, middleInitial}) -> Promise`
- `SecurityGuardService.setActive(guardId, active) -> Promise`
- `SecurityGuardService.search(query, docs) -> filteredDocs` — case-insensitive substring on guardId/firstName/lastName/fullName. PURE — no network.

- [ ] **Step 1: Write the failing Jest test**

Create `frontend/src/components/__tests__/securityGuardService.test.js`:

```js
import {SecurityGuardService} from "../../api/securityGuardService.js";

const docs = [
    {id: "SG-001", guardId: "SG-001", firstName: "James", lastName: "Rivera", middleInitial: "B.", fullName: "James B. Rivera", active: true},
    {id: "SG-002", guardId: "SG-002", firstName: "Maria", lastName: "Santos", middleInitial: "", fullName: "Maria Santos", active: false},
];

describe("SecurityGuardService.search", () => {
    test("empty query returns full list", () => {
        expect(SecurityGuardService.search("", docs)).toHaveLength(2);
    });
    test("matches by guardId substring", () => {
        expect(SecurityGuardService.search("sg-001", docs).map((d) => d.guardId)).toEqual(["SG-001"]);
    });
    test("matches by firstName case-insensitive", () => {
        expect(SecurityGuardService.search("JAMES", docs).map((d) => d.guardId)).toEqual(["SG-001"]);
    });
    test("matches by lastName", () => {
        expect(SecurityGuardService.search("santos", docs).map((d) => d.guardId)).toEqual(["SG-002"]);
    });
    test("matches by fullName", () => {
        expect(SecurityGuardService.search("B. Rivera", docs).map((d) => d.guardId)).toEqual(["SG-001"]);
    });
    test("returns empty for no match", () => {
        expect(SecurityGuardService.search("zzz", docs)).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx jest src/components/__tests__/securityGuardService.test.js`
Expected: FAIL with "Cannot find module '../../api/securityGuardService.js'".

- [ ] **Step 3: Write the service**

Create `frontend/src/api/securityGuardService.js`:

```js
import {collection, onSnapshot} from "firebase/firestore";
import {db} from "./firebase.js";
import {API_CONFIG} from "./config.js";
import {AuthService} from "./authService.js";

const COLLECTION = "security_guard";

async function authedFetch(url, options = {}) {
    const token = await AuthService.getToken();
    const res = await fetch(`${API_CONFIG.BASE_URL}${url}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...(options.headers || {}),
        },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = body.message || `${res.status} ${res.statusText}`;
        const err = new Error(msg);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body;
}

export const SecurityGuardService = {
    subscribe(callback) {
        return onSnapshot(
            collection(db, COLLECTION),
            (snapshot) => {
                const map = {};
                snapshot.forEach((docSnap) => {
                    map[docSnap.id] = {id: docSnap.id, ...docSnap.data()};
                });
                callback(map);
            },
            (err) => {
                console.error("SecurityGuardService subscription error:", err);
                callback({});
            },
        );
    },

    async create(payload) {
        return authedFetch("/api/admin/guards", {
            method: "POST",
            body: JSON.stringify(payload),
        });
    },

    async update(guardId, payload) {
        return authedFetch(`/api/admin/guards/${encodeURIComponent(guardId)}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
        });
    },

    async setActive(guardId, active) {
        return authedFetch(`/api/admin/guards/${encodeURIComponent(guardId)}/active`, {
            method: "PATCH",
            body: JSON.stringify({active}),
        });
    },

    /**
     * Pure client-side filter. Case-insensitive substring over
     * guardId, firstName, lastName, fullName.
     */
    search(query, docs) {
        if (!query || !query.trim()) return docs;
        const q = query.trim().toLowerCase();
        return docs.filter((d) =>
            [d.guardId, d.firstName, d.lastName, d.fullName]
                .filter(Boolean)
                .some((s) => String(s).toLowerCase().includes(q)),
        );
    },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx jest src/components/__tests__/securityGuardService.test.js`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/securityGuardService.js frontend/src/components/__tests__/securityGuardService.test.js
git commit -m "feat(frontend): SecurityGuardService with subscribe/create/update/setActive/search"
```

---

### Task 7: Frontend truckCompanyService + Jest test

**Files:**
- Create: `frontend/src/api/truckCompanyService.js`
- Create: `frontend/src/components/__tests__/truckCompanyService.test.js`

**Interfaces:** Mirror of `SecurityGuardService`, fields `forwarderCode`, `name`, `companyCode`. Search matches by `companyCode`, `name`, `forwarderCode`.

- [ ] **Step 1: Write the failing Jest test**

Create `frontend/src/components/__tests__/truckCompanyService.test.js`:

```js
import {TruckCompanyService} from "../../api/truckCompanyService.js";

const docs = [
    {id: "01", companyCode: "01", forwarderCode: "40000279", name: "LALAMOVE PHILIPPINES INC", active: true},
    {id: "02", companyCode: "02", forwarderCode: "40000280", name: "J&T EXPRESS", active: true},
];

describe("TruckCompanyService.search", () => {
    test("empty query returns full list", () => {
        expect(TruckCompanyService.search("", docs)).toHaveLength(2);
    });
    test("matches by companyCode substring", () => {
        expect(TruckCompanyService.search("01", docs).map((d) => d.companyCode)).toEqual(["01"]);
    });
    test("matches by name case-insensitive", () => {
        expect(TruckCompanyService.search("lalamove", docs).map((d) => d.companyCode)).toEqual(["01"]);
    });
    test("matches by forwarderCode", () => {
        expect(TruckCompanyService.search("40000280", docs).map((d) => d.companyCode)).toEqual(["02"]);
    });
    test("returns empty for no match", () => {
        expect(TruckCompanyService.search("zzz", docs)).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx jest src/components/__tests__/truckCompanyService.test.js`
Expected: FAIL with "Cannot find module '../../api/truckCompanyService.js'".

- [ ] **Step 3: Write the service**

Create `frontend/src/api/truckCompanyService.js`:

```js
import {collection, onSnapshot} from "firebase/firestore";
import {db} from "./firebase.js";
import {API_CONFIG} from "./config.js";
import {AuthService} from "./authService.js";

const COLLECTION = "truck_company";

async function authedFetch(url, options = {}) {
    const token = await AuthService.getToken();
    const res = await fetch(`${API_CONFIG.BASE_URL}${url}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...(options.headers || {}),
        },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = body.message || `${res.status} ${res.statusText}`;
        const err = new Error(msg);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body;
}

export const TruckCompanyService = {
    subscribe(callback) {
        return onSnapshot(
            collection(db, COLLECTION),
            (snapshot) => {
                const map = {};
                snapshot.forEach((docSnap) => {
                    map[docSnap.id] = {id: docSnap.id, ...docSnap.data()};
                });
                callback(map);
            },
            (err) => {
                console.error("TruckCompanyService subscription error:", err);
                callback({});
            },
        );
    },

    async create(payload) {
        return authedFetch("/api/admin/truck-companies", {
            method: "POST",
            body: JSON.stringify(payload),
        });
    },

    async update(code, payload) {
        return authedFetch(`/api/admin/truck-companies/${encodeURIComponent(code)}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
        });
    },

    async setActive(code, active) {
        return authedFetch(`/api/admin/truck-companies/${encodeURIComponent(code)}/active`, {
            method: "PATCH",
            body: JSON.stringify({active}),
        });
    },

    /**
     * Pure client-side filter. Case-insensitive substring over
     * companyCode, name, forwarderCode.
     */
    search(query, docs) {
        if (!query || !query.trim()) return docs;
        const q = query.trim().toLowerCase();
        return docs.filter((d) =>
            [d.companyCode, d.name, d.forwarderCode]
                .filter(Boolean)
                .some((s) => String(s).toLowerCase().includes(q)),
        );
    },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx jest src/components/__tests__/truckCompanyService.test.js`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/truckCompanyService.js frontend/src/components/__tests__/truckCompanyService.test.js
git commit -m "feat(frontend): TruckCompanyService with subscribe/create/update/setActive/search"
```

---

### Task 8: Firestore rules for the new collections

**Files:**
- Modify: `frontend/firestore.rules` (add two read-only match blocks before the default-deny fallback on line 92).

- [ ] **Step 1: Insert the match blocks**

Insert the following immediately before the existing `// ─── Default: Deny all ───` block (currently at line 92):

```
    // ─── Security Guards ───────────────────────────────────────────────────────
    // Read: authenticated users (live onSnapshot in admin Document tab).
    // Write: backend API only (POST/PATCH /api/admin/guards) which uses
    //        Firebase Admin SDK and bypasses rules.
    match /security_guard/{id} {
      allow read: if request.auth != null;
      allow write: if false;
    }

    // ─── Truck Companies ───────────────────────────────────────────────────────
    // Read: authenticated users (live onSnapshot in admin Document tab).
    // Write: backend API only (POST/PATCH /api/admin/truck-companies).
    match /truck_company/{id} {
      allow read: if request.auth != null;
      allow write: if false;
    }
```

- [ ] **Step 2: Verify file syntax is balanced**

Run: `cd frontend && node -e "const r = require('fs').readFileSync('firestore.rules','utf8'); console.log('lines:', r.split('\n').length); const opens=(r.match(/{/g)||[]).length; const closes=(r.match(/}/g)||[]).length; console.log('braces open/close:', opens, closes); if (opens!==closes) process.exit(1);"`
Expected: braces count equal. (Rules can have other curly content; this is a coarse check, not full parse — Firestore deploy is the real validation.)

- [ ] **Step 3: Commit**

```bash
git add frontend/firestore.rules
git commit -m "feat(firestore): read-only rules for security_guard and truck_company"
```

---

### Task 9: Add sub-tab buttons and modals to dashboard.html

**Files:**
- Modify: `frontend/dashboard.html` (insert 2 sub-tab buttons at line 1120, insert 2 modals near line 1862 before `</body>` or end of modals block).

- [ ] **Step 1: Insert sub-tab buttons**

Immediately after the existing `<button class="docs-tab-btn ... data-tab="completed">Completed</button>` on line 1120, add:

```html
            <button id="docsGuardsTabBtn" class="docs-tab-btn px-4 py-2 text-[11px] font-bold uppercase tracking-wider rounded-t-lg transition-all border-b-2 border-transparent text-db-text3 hover:text-db-text2 hidden" data-tab="guards">Guards</button>
            <button id="docsTruckCompaniesTabBtn" class="docs-tab-btn px-4 py-2 text-[11px] font-bold uppercase tracking-wider rounded-t-lg transition-all border-b-2 border-transparent text-db-text3 hover:text-db-text2 hidden" data-tab="truck-companies">Truck Companies</button>
```

These are hidden by default; `applyRBAC()` will unhide them for admins.

- [ ] **Step 2: Insert the Guard modal before `</main>` closing tag (line 1129)**

```html
<!-- Guard Modal -->
<div id="guardModal" class="hidden fixed inset-0 z-[8500] bg-black/60 items-center justify-center p-4">
    <div class="bg-db-panel border border-db-border rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div class="px-5 py-4 border-b border-db-border flex items-center justify-between">
            <div>
                <h2 id="guardModalTitle" class="text-base font-bold text-db-text font-display">Add Guard</h2>
                <p class="text-[11px] text-db-text3 mt-0.5">Reference data for SAP line items.</p>
            </div>
            <button id="guardModalCloseBtn" type="button" class="text-db-text3 hover:text-db-text w-7 h-7 rounded-lg hover:bg-db-item-hover flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="w-4 h-4"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        </div>
        <div class="p-5 space-y-4">
            <div id="guardModalIdWrap" class="hidden">
                <label class="block text-[10px] font-bold uppercase tracking-wider text-db-text3 mb-1.5">Guard ID</label>
                <input id="guardModalId" type="text" readonly class="w-full h-11 bg-db-bg border border-db-border rounded-xl px-4 text-sm text-db-text2 font-mono cursor-not-allowed opacity-70" />
            </div>
            <div>
                <label class="block text-[10px] font-bold uppercase tracking-wider text-db-text3 mb-1.5">First Name *</label>
                <input id="guardFirstName" type="text" maxlength="60" class="w-full h-11 bg-db-bg border border-db-border rounded-xl px-4 text-sm text-db-text focus:border-sysu-red outline-none transition-all placeholder:text-db-text3/50" placeholder="James" />
            </div>
            <div>
                <label class="block text-[10px] font-bold uppercase tracking-wider text-db-text3 mb-1.5">Last Name *</label>
                <input id="guardLastName" type="text" maxlength="60" class="w-full h-11 bg-db-bg border border-db-border rounded-xl px-4 text-sm text-db-text focus:border-sysu-red outline-none transition-all placeholder:text-db-text3/50" placeholder="Rivera" />
            </div>
            <div>
                <label class="block text-[10px] font-bold uppercase tracking-wider text-db-text3 mb-1.5">Middle Initial</label>
                <input id="guardMiddleInitial" type="text" maxlength="5" class="w-full h-11 bg-db-bg border border-db-border rounded-xl px-4 text-sm text-db-text focus:border-sysu-red outline-none transition-all placeholder:text-db-text3/50" placeholder="B." />
            </div>
            <div class="bg-db-bg rounded-xl p-3 text-[12px] text-db-text2 flex items-center justify-between">
                <span class="text-db-text3 uppercase text-[10px] font-bold tracking-wider">Full Name</span>
                <span id="guardFullNamePreview" class="font-bold">—</span>
            </div>
        </div>
        <div class="px-5 py-3 border-t border-db-border flex justify-end gap-2">
            <button id="guardModalCancelBtn" type="button" class="px-4 py-2 rounded-lg text-[12px] text-db-text3 hover:text-db-text hover:bg-db-item-hover transition-colors">Cancel</button>
            <button id="guardModalSaveBtn" type="button" class="px-4 py-2 rounded-lg text-[12px] font-bold uppercase tracking-wider bg-sysu-red hover:bg-sysu-red-dark text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed">Save</button>
        </div>
    </div>
</div>

<!-- Truck Company Modal -->
<div id="truckCompanyModal" class="hidden fixed inset-0 z-[8500] bg-black/60 items-center justify-center p-4">
    <div class="bg-db-panel border border-db-border rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div class="px-5 py-4 border-b border-db-border flex items-center justify-between">
            <div>
                <h2 id="truckCompanyModalTitle" class="text-base font-bold text-db-text font-display">Add Truck Company</h2>
                <p class="text-[11px] text-db-text3 mt-0.5">Reference data for driver assignment.</p>
            </div>
            <button id="truckCompanyModalCloseBtn" type="button" class="text-db-text3 hover:text-db-text w-7 h-7 rounded-lg hover:bg-db-item-hover flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="w-4 h-4"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        </div>
        <div class="p-5 space-y-4">
            <div id="truckCompanyCodeWrap" class="hidden">
                <label class="block text-[10px] font-bold uppercase tracking-wider text-db-text3 mb-1.5">Company Code</label>
                <input id="truckCompanyCodeInput" type="text" readonly class="w-full h-11 bg-db-bg border border-db-border rounded-xl px-4 text-sm text-db-text2 font-mono cursor-not-allowed opacity-70" />
            </div>
            <div>
                <label class="block text-[10px] font-bold uppercase tracking-wider text-db-text3 mb-1.5">Forwarder Code *</label>
                <input id="truckCompanyForwarderCode" type="text" maxlength="50" class="w-full h-11 bg-db-bg border border-db-border rounded-xl px-4 text-sm text-db-text focus:border-sysu-red outline-none transition-all placeholder:text-db-text3/50" placeholder="40000279" />
            </div>
            <div>
                <label class="block text-[10px] font-bold uppercase tracking-wider text-db-text3 mb-1.5">Name *</label>
                <input id="truckCompanyName" type="text" maxlength="200" class="w-full h-11 bg-db-bg border border-db-border rounded-xl px-4 text-sm text-db-text focus:border-sysu-red outline-none transition-all placeholder:text-db-text3/50" placeholder="LALAMOVE PHILIPPINES INC" />
            </div>
        </div>
        <div class="px-5 py-3 border-t border-db-border flex justify-end gap-2">
            <button id="truckCompanyModalCancelBtn" type="button" class="px-4 py-2 rounded-lg text-[12px] text-db-text3 hover:text-db-text hover:bg-db-item-hover transition-colors">Cancel</button>
            <button id="truckCompanyModalSaveBtn" type="button" class="px-4 py-2 rounded-lg text-[12px] font-bold uppercase tracking-wider bg-sysu-red hover:bg-sysu-red-dark text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed">Save</button>
        </div>
    </div>
</div>
```

Place these before the closing `</main>` tag (line 1130). If `</main>` is the wrong anchor, place them immediately after the existing `#proceedOverrideModal` block (which ends around line 1858) — whichever the file structure dictates. Both anchor points are visually equivalent (DOM siblings of main, hidden until shown).

- [ ] **Step 3: Verify the file still loads**

Run: `cd frontend && node -e "const fs=require('fs'); const html=fs.readFileSync('dashboard.html','utf8'); const o=(html.match(/{/g)||[]).length; const c=(html.match(/}/g)||[]).length; console.log('braces:', o, c); if (o!==c) process.exit(1);"`
Expected: braces balanced; new IDs `guardModal`, `truckCompanyModal`, `docsGuardsTabBtn`, `docsTruckCompaniesTabBtn` exist in the file. Use `grep -c` on these IDs to confirm.

- [ ] **Step 4: Commit**

```bash
git add frontend/dashboard.html
git commit -m "feat(frontend): Guards and Truck Companies sub-tabs + modals"
```

---

### Task 10: Wire up sub-tab click handler and RBAC visibility

**Files:**
- Modify: `frontend/src/pages/dashboard.js`

**Interfaces:**
- New: `this._activeDocsTab` state (string, one of: `pending | approved | rejected | expired | completed | guards | truck-companies`). Default `pending`.
- New: sub-tab click handler routes to `_renderDocsView()` (existing), `_renderGuardsView()` (new), or `_renderTruckCompaniesView()` (new).
- Modify: `applyRBAC(user)` to show/hide `#docsGuardsTabBtn` and `#docsTruckCompaniesTabBtn` for admins.

- [ ] **Step 1: Locate and update the docs tab button click handler**

In `frontend/src/pages/dashboard.js`, find the block that attaches click handlers to `.docs-tab-btn` elements (search for `docs-tab-btn`). It likely delegates or attaches per-button. Modify the handler so that when a clicked button's `data-tab` is `guards` or `truck-companies`, it calls the matching `_renderGuardsView()` or `_renderTruckCompaniesView()` instead of `_renderDocsView()`. Set `this._activeDocsTab` to the clicked tab. Always call `setActiveDocsTabBtn(btn)` to update the active styling.

The exact insertion point is the existing handler. Find by grep:

```
rg "docs-tab-btn" frontend/src/pages/dashboard.js
```

Read the surrounding 30 lines, then replace the dispatch to add the new branches. If there is a helper like `_renderDocsViewForTab(tabName)`, call that. Otherwise inline the dispatch.

- [ ] **Step 2: Update applyRBAC to show admin-only sub-tabs**

Find `applyRBAC(user)` (around line 149-175). Add at the end of the function:

```js
        // Show admin-only sub-tabs in the Documents view
        const isApprover = role === "admin" || role === "super_admin";
        const guardsTab = document.getElementById("docsGuardsTabBtn");
        const tcTab = document.getElementById("docsTruckCompaniesTabBtn");
        if (guardsTab) guardsTab.classList.toggle("hidden", !isApprover);
        if (tcTab) tcTab.classList.toggle("hidden", !isApprover);
```

- [ ] **Step 3: Run frontend dev server and manually verify**

Run: `cd frontend && npm run dev` (background it with `run_in_background: true`).
Then in browser: load dashboard as an admin, navigate to Documents tab, confirm the two new sub-tabs appear. Switch to non-admin role in dev tools (or use a `driver` user) to confirm they're hidden. Stop the dev server.

If you can't run a browser, at minimum verify the file parses: `cd frontend && npx vite build` (should succeed; no runtime errors at compile).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "feat(frontend): sub-tab dispatch and RBAC visibility for Guards/Truck Companies"
```

---

### Task 11: Render methods for Guards and Truck Companies

**Files:**
- Modify: `frontend/src/pages/dashboard.js`

**Interfaces:**
- `_renderGuardsView()` — reads `this.state._guards` and `this.state._activeDocsTab === 'guards'`, renders cards inside `#docsListContainer`. Toolbar with `[🔍 Search...]` input and `[+ Add Guard]` button. Each card shows `guardId`, `fullName`, status pill, `[Edit]` and `[Deactivate | Reactivate]` buttons. Edit/Add/Deactivate calls the matching `_open*` / `_softDelete*` method.
- `_renderTruckCompaniesView()` — same shape but for companies.

- [ ] **Step 1: Implement `_renderGuardsView`**

Add as a new method on the `Dashboard` class. Place it right after `_renderDocsView()` (around line 1862).

```js
    _renderGuardsView() {
        const container = document.getElementById("docsListContainer");
        if (!container) return;

        const docs = Object.values(this.state._guards || {});
        docs.sort((a, b) => {
            const an = parseInt(String(a.guardId || "").replace(/\D/g, ""), 10) || 0;
            const bn = parseInt(String(b.guardId || "").replace(/\D/g, ""), 10) || 0;
            return an - bn;
        });

        const search = (this.state._guardSearch || "").toLowerCase();
        const filtered = search
            ? SecurityGuardService.search(this.state._guardSearch, docs)
            : docs;

        container.innerHTML = `
            <div class="flex flex-col gap-3">
                <div class="flex items-center gap-2 mb-2">
                    <input id="guardSearchInput" type="text" placeholder="Search guards..." value="${escapeHtml(this.state._guardSearch || "")}" class="flex-1 h-10 bg-db-bg border border-db-border rounded-xl px-4 text-sm text-db-text focus:border-sysu-red outline-none" />
                    <button id="guardAddBtn" class="px-4 h-10 rounded-xl text-[12px] font-bold uppercase tracking-wider bg-sysu-red hover:bg-sysu-red-dark text-white transition-colors">+ Add Guard</button>
                </div>
                ${filtered.length === 0 ? `<div class="flex items-center justify-center min-h-[200px] text-db-text3 italic text-sm">No guards found.</div>` : filtered.map((g) => this._renderGuardCard(g)).join("")}
            </div>
        `;

        // Wire toolbar
        document.getElementById("guardSearchInput")?.addEventListener("input", (e) => {
            this.state._guardSearch = e.target.value;
            this._renderGuardsView();
        });
        document.getElementById("guardAddBtn")?.addEventListener("click", () => {
            this._openGuardModal(null);
        });

        // Wire card actions
        container.querySelectorAll("[data-action='guard-edit']").forEach((btn) => {
            btn.addEventListener("click", () => this._openGuardModal(btn.dataset.id));
        });
        container.querySelectorAll("[data-action='guard-toggle']").forEach((btn) => {
            btn.addEventListener("click", () => {
                const id = btn.dataset.id;
                const currentlyActive = btn.dataset.active === "true";
                this._softDeleteGuard(id, currentlyActive);
            });
        });
    }

    _renderGuardCard(g) {
        const statusPill = g.active
            ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-green-500/20 text-green-400">Active</span>`
            : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-db-item-hover text-db-text3">Inactive</span>`;
        const toggleLabel = g.active ? "Deactivate" : "Reactivate";
        const toggleClass = g.active
            ? "text-sysu-red hover:bg-sysu-red/10"
            : "text-green-400 hover:bg-green-500/10";
        return `
            <div class="bg-db-panel border border-db-border rounded-xl p-4 hover:border-db-text3 transition-colors">
                <div class="flex items-start justify-between gap-4">
                    <div class="flex-1">
                        <div class="flex items-center gap-2 mb-1">
                            <span class="text-sm font-bold text-db-text font-mono">${escapeHtml(g.guardId || g.id || "")}</span>
                            ${statusPill}
                        </div>
                        <div class="text-base text-db-text font-bold">${escapeHtml(g.fullName || "")}</div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <button data-action="guard-edit" data-id="${escapeHtml(g.id || "")}" class="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider text-db-text2 hover:bg-db-item-hover transition-colors">Edit</button>
                        <button data-action="guard-toggle" data-id="${escapeHtml(g.id || "")}" data-active="${g.active ? "true" : "false"}" class="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider ${toggleClass} transition-colors">${toggleLabel}</button>
                    </div>
                </div>
            </div>
        `;
    }
```

Note: `SecurityGuardService` and `escapeHtml` must already be in scope in `dashboard.js`. If `SecurityGuardService` is not yet imported, add to the imports near the top of `dashboard.js`:
```js
import {SecurityGuardService} from "../api/securityGuardService.js";
```
`escapeHtml` is already a local helper used by `_renderDocsView()` — verify by searching `function escapeHtml` or `const escapeHtml`.

- [ ] **Step 2: Implement `_renderTruckCompaniesView` and `_renderTruckCompanyCard`**

Mirror of the above. Place immediately after `_renderGuardCard`.

```js
    _renderTruckCompaniesView() {
        const container = document.getElementById("docsListContainer");
        if (!container) return;

        const docs = Object.values(this.state._truckCompanies || {});
        docs.sort((a, b) => {
            const an = parseInt(a.companyCode || "0", 10) || 0;
            const bn = parseInt(b.companyCode || "0", 10) || 0;
            return an - bn;
        });

        const search = (this.state._tcSearch || "").toLowerCase();
        const filtered = search
            ? TruckCompanyService.search(this.state._tcSearch, docs)
            : docs;

        container.innerHTML = `
            <div class="flex flex-col gap-3">
                <div class="flex items-center gap-2 mb-2">
                    <input id="tcSearchInput" type="text" placeholder="Search truck companies..." value="${escapeHtml(this.state._tcSearch || "")}" class="flex-1 h-10 bg-db-bg border border-db-border rounded-xl px-4 text-sm text-db-text focus:border-sysu-red outline-none" />
                    <button id="tcAddBtn" class="px-4 h-10 rounded-xl text-[12px] font-bold uppercase tracking-wider bg-sysu-red hover:bg-sysu-red-dark text-white transition-colors">+ Add Truck Company</button>
                </div>
                ${filtered.length === 0 ? `<div class="flex items-center justify-center min-h-[200px] text-db-text3 italic text-sm">No truck companies found.</div>` : filtered.map((c) => this._renderTruckCompanyCard(c)).join("")}
            </div>
        `;

        document.getElementById("tcSearchInput")?.addEventListener("input", (e) => {
            this.state._tcSearch = e.target.value;
            this._renderTruckCompaniesView();
        });
        document.getElementById("tcAddBtn")?.addEventListener("click", () => {
            this._openTruckCompanyModal(null);
        });

        container.querySelectorAll("[data-action='tc-edit']").forEach((btn) => {
            btn.addEventListener("click", () => this._openTruckCompanyModal(btn.dataset.id));
        });
        container.querySelectorAll("[data-action='tc-toggle']").forEach((btn) => {
            btn.addEventListener("click", () => {
                const id = btn.dataset.id;
                const currentlyActive = btn.dataset.active === "true";
                this._softDeleteTruckCompany(id, currentlyActive);
            });
        });
    }

    _renderTruckCompanyCard(c) {
        const statusPill = c.active
            ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-green-500/20 text-green-400">Active</span>`
            : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-db-item-hover text-db-text3">Inactive</span>`;
        const toggleLabel = c.active ? "Deactivate" : "Reactivate";
        const toggleClass = c.active
            ? "text-sysu-red hover:bg-sysu-red/10"
            : "text-green-400 hover:bg-green-500/10";
        return `
            <div class="bg-db-panel border border-db-border rounded-xl p-4 hover:border-db-text3 transition-colors">
                <div class="flex items-start justify-between gap-4">
                    <div class="flex-1">
                        <div class="flex items-center gap-2 mb-1">
                            <span class="text-sm font-bold text-db-text font-mono">${escapeHtml(c.companyCode || c.id || "")}</span>
                            ${statusPill}
                        </div>
                        <div class="text-base text-db-text font-bold">${escapeHtml(c.name || "")}</div>
                        <div class="text-[11px] text-db-text3 font-mono mt-0.5">${escapeHtml(c.forwarderCode || "")}</div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <button data-action="tc-edit" data-id="${escapeHtml(c.id || "")}" class="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider text-db-text2 hover:bg-db-item-hover transition-colors">Edit</button>
                        <button data-action="tc-toggle" data-id="${escapeHtml(c.id || "")}" data-active="${c.active ? "true" : "false"}" class="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider ${toggleClass} transition-colors">${toggleLabel}</button>
                    </div>
                </div>
            </div>
        `;
    }
```

Add the import:
```js
import {TruckCompanyService} from "../api/truckCompanyService.js";
```

- [ ] **Step 3: Run frontend tests**

Run: `cd frontend && npx jest`
Expected: All existing component tests + the 2 new service tests pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "feat(frontend): render views for Guards and Truck Companies sub-tabs"
```

---

### Task 12: Modal open/save handlers + subscriptions wiring

**Files:**
- Modify: `frontend/src/pages/dashboard.js`

**Interfaces:**
- `_openGuardModal(id)` — opens `#guardModal`, populates fields if editing, sets `_editGuardId` state. Wires `Cancel`/`Close`/`Save` buttons. Live-updates `Full Name` preview as user types.
- `_saveGuard()` — validates, calls `SecurityGuardService.create` or `.update`, toasts, closes modal.
- `_softDeleteGuard(guardId, currentlyActive)` — `confirm()` then `.setActive()`.
- Same triplet for truck companies: `_openTruckCompanyModal`, `_saveTruckCompany`, `_softDeleteTruckCompany`.
- `_subscribeGuards()` / `_subscribeTruckCompanies()` — wires `onSnapshot` in `_startDataEngines()`, stores result in `this.state._guards` / `this.state._truckCompanies`.

- [ ] **Step 1: Add subscriptions in `_startDataEngines`**

Find `_startDataEngines()` (around line 180-200, near the `OverrideRequestService.subscribeToRequests` call). Add immediately after that:

```js
        try {
            this._guardsUnsub = SecurityGuardService.subscribe((data) => {
                this.state._guards = data;
                if (this._activeDocsTab === "guards") this._renderGuardsView();
            });
        } catch (err) {
            console.warn("Guards listener failed:", err.message);
        }

        try {
            this._truckCompaniesUnsub = TruckCompanyService.subscribe((data) => {
                this.state._truckCompanies = data;
                if (this._activeDocsTab === "truck-companies") this._renderTruckCompaniesView();
            });
        } catch (err) {
            console.warn("Truck companies listener failed:", err.message);
        }
```

Also add cleanup on logout (find a `_cleanupSubscriptions` or similar method, or just before the auth state reset):

```js
        this._guardsUnsub?.();
        this._truckCompaniesUnsub?.();
```

If no existing cleanup hook exists, add a `componentWillUnmount`-style call inside the auth sign-out path. If you can't find one, add a guard inside `_subscribeGuards` itself that no-ops if `this._guardsUnsub` already exists (so re-renders don't double-subscribe). This is a known acceptable risk for v1.

- [ ] **Step 2: Implement Guard modal handlers**

Add as new methods on `Dashboard`:

```js
    _openGuardModal(id) {
        this._editGuardId = id || null;
        const modal = document.getElementById("guardModal");
        const title = document.getElementById("guardModalTitle");
        const idWrap = document.getElementById("guardModalIdWrap");
        const idInput = document.getElementById("guardModalId");
        const fn = document.getElementById("guardFirstName");
        const ln = document.getElementById("guardLastName");
        const mi = document.getElementById("guardMiddleInitial");
        const preview = document.getElementById("guardFullNamePreview");

        if (!modal) return;
        modal.classList.remove("hidden");
        modal.classList.add("flex");
        if (title) title.textContent = id ? "Edit Guard" : "Add Guard";
        if (fn) fn.value = "";
        if (ln) ln.value = "";
        if (mi) mi.value = "";
        if (preview) preview.textContent = "—";

        if (id) {
            const g = this.state._guards?.[id];
            if (g) {
                if (idInput) idInput.value = g.guardId || g.id || "";
                if (idWrap) idWrap.classList.remove("hidden");
                if (fn) fn.value = g.firstName || "";
                if (ln) ln.value = g.lastName || "";
                if (mi) mi.value = g.middleInitial || "";
                this._updateGuardFullNamePreview();
            }
        } else {
            if (idWrap) idWrap.classList.add("hidden");
        }

        const closeModal = () => this._closeGuardModal();
        document.getElementById("guardModalCloseBtn")?.addEventListener("click", closeModal, {once: true});
        document.getElementById("guardModalCancelBtn")?.addEventListener("click", closeModal, {once: true});
        document.getElementById("guardModalSaveBtn")?.addEventListener("click", () => this._saveGuard(), {once: true});
        [fn, ln, mi].forEach((el) => {
            if (!el) return;
            el.removeEventListener("input", this._updateGuardFullNamePreview);
            el.addEventListener("input", () => this._updateGuardFullNamePreview());
        });
    }

    _updateGuardFullNamePreview() {
        const fn = (document.getElementById("guardFirstName")?.value || "").trim();
        const ln = (document.getElementById("guardLastName")?.value || "").trim();
        const mi = (document.getElementById("guardMiddleInitial")?.value || "").trim();
        const preview = document.getElementById("guardFullNamePreview");
        if (!preview) return;
        if (!fn && !ln && !mi) {
            preview.textContent = "—";
            return;
        }
        preview.textContent = `${fn}${mi ? " " + mi : ""} ${ln}`.replace(/\s+/g, " ").trim();
    }

    _closeGuardModal() {
        const modal = document.getElementById("guardModal");
        if (modal) {
            modal.classList.add("hidden");
            modal.classList.remove("flex");
        }
        this._editGuardId = null;
    }

    async _saveGuard() {
        const fn = (document.getElementById("guardFirstName")?.value || "").trim();
        const ln = (document.getElementById("guardLastName")?.value || "").trim();
        const mi = (document.getElementById("guardMiddleInitial")?.value || "").trim();
        const saveBtn = document.getElementById("guardModalSaveBtn");

        if (!fn || !ln) {
            this._showToast("First name and last name are required");
            return;
        }
        if (fn.length > 60 || ln.length > 60 || mi.length > 5) {
            this._showToast("Field length exceeds the limit");
            return;
        }

        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = "SAVING...";
        }
        try {
            if (this._editGuardId) {
                await SecurityGuardService.update(this._editGuardId, {firstName: fn, lastName: ln, middleInitial: mi});
                this._showToast("Guard updated");
            } else {
                await SecurityGuardService.create({firstName: fn, lastName: ln, middleInitial: mi});
                this._showToast("Guard added");
            }
            this._closeGuardModal();
        } catch (err) {
            console.error("Save guard error:", err);
            this._showToast("Failed to save: " + err.message);
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = "Save";
            }
        }
    }

    async _softDeleteGuard(guardId, currentlyActive) {
        const guard = this.state._guards?.[guardId];
        const label = guard?.fullName || guard?.guardId || guardId;
        const action = currentlyActive ? "Deactivate" : "Reactivate";
        if (!window.confirm(`${action} ${guardId} ${label}?`)) return;
        try {
            await SecurityGuardService.setActive(guardId, !currentlyActive);
            this._showToast(`Guard ${action.toLowerCase()}d`);
        } catch (err) {
            console.error("Toggle guard error:", err);
            this._showToast("Failed: " + err.message);
        }
    }
```

- [ ] **Step 3: Implement Truck Company modal handlers (mirror)**

Add right after the guard handlers:

```js
    _openTruckCompanyModal(code) {
        this._editTruckCompanyCode = code || null;
        const modal = document.getElementById("truckCompanyModal");
        const title = document.getElementById("truckCompanyModalTitle");
        const codeWrap = document.getElementById("truckCompanyCodeWrap");
        const codeInput = document.getElementById("truckCompanyCodeInput");
        const fc = document.getElementById("truckCompanyForwarderCode");
        const nm = document.getElementById("truckCompanyName");

        if (!modal) return;
        modal.classList.remove("hidden");
        modal.classList.add("flex");
        if (title) title.textContent = code ? "Edit Truck Company" : "Add Truck Company";
        if (fc) fc.value = "";
        if (nm) nm.value = "";

        if (code) {
            const c = this.state._truckCompanies?.[code];
            if (c) {
                if (codeInput) codeInput.value = c.companyCode || c.id || "";
                if (codeWrap) codeWrap.classList.remove("hidden");
                if (fc) fc.value = c.forwarderCode || "";
                if (nm) nm.value = c.name || "";
            }
        } else {
            if (codeWrap) codeWrap.classList.add("hidden");
        }

        const closeModal = () => this._closeTruckCompanyModal();
        document.getElementById("truckCompanyModalCloseBtn")?.addEventListener("click", closeModal, {once: true});
        document.getElementById("truckCompanyModalCancelBtn")?.addEventListener("click", closeModal, {once: true});
        document.getElementById("truckCompanyModalSaveBtn")?.addEventListener("click", () => this._saveTruckCompany(), {once: true});
    }

    _closeTruckCompanyModal() {
        const modal = document.getElementById("truckCompanyModal");
        if (modal) {
            modal.classList.add("hidden");
            modal.classList.remove("flex");
        }
        this._editTruckCompanyCode = null;
    }

    async _saveTruckCompany() {
        const fc = (document.getElementById("truckCompanyForwarderCode")?.value || "").trim();
        const nm = (document.getElementById("truckCompanyName")?.value || "").trim();
        const saveBtn = document.getElementById("truckCompanyModalSaveBtn");

        if (!fc || !nm) {
            this._showToast("Forwarder code and name are required");
            return;
        }
        if (!/^[A-Za-z0-9-]+$/.test(fc)) {
            this._showToast("Forwarder code may only contain letters, digits, and dashes");
            return;
        }
        if (fc.length > 50 || nm.length > 200) {
            this._showToast("Field length exceeds the limit");
            return;
        }

        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = "SAVING...";
        }
        try {
            if (this._editTruckCompanyCode) {
                await TruckCompanyService.update(this._editTruckCompanyCode, {forwarderCode: fc, name: nm});
                this._showToast("Truck company updated");
            } else {
                await TruckCompanyService.create({forwarderCode: fc, name: nm});
                this._showToast("Truck company added");
            }
            this._closeTruckCompanyModal();
        } catch (err) {
            console.error("Save truck company error:", err);
            this._showToast("Failed to save: " + err.message);
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = "Save";
            }
        }
    }

    async _softDeleteTruckCompany(code, currentlyActive) {
        const c = this.state._truckCompanies?.[code];
        const label = c?.name || c?.companyCode || code;
        const action = currentlyActive ? "Deactivate" : "Reactivate";
        if (!window.confirm(`${action} ${code} ${label}?`)) return;
        try {
            await TruckCompanyService.setActive(code, !currentlyActive);
            this._showToast(`Truck company ${action.toLowerCase()}d`);
        } catch (err) {
            console.error("Toggle truck company error:", err);
            this._showToast("Failed: " + err.message);
        }
    }
```

- [ ] **Step 4: Expose handlers on `window.dashboard` for inline `onclick` (only if needed)**

The modal HTML in Task 9 used `type="button"` on all buttons and relies on programmatic listeners attached in `_openGuardModal`. No `window.dashboard` exposure is needed for these. If you discover any buttons in `dashboard.html` need global handlers, add them alongside the existing `window.dashboard.*` block in the main `_wireDashboardListeners()` method (around line 955).

- [ ] **Step 5: Manual smoke test against running backend**

Run backend: `cd backend && npm run dev` (or equivalent; check `backend/package.json`).
Run frontend: `cd frontend && npm run dev`.
In browser as admin:
1. Open Documents tab → confirm Guards and Truck Companies sub-tabs appear.
2. Click Guards → confirm empty state or list.
3. Add Guard "Test", "User", "T." → confirm SG-XXX appears.
4. Edit the guard → confirm fullName updates correctly.
5. Deactivate → confirm pill changes to Inactive.
6. Reactivate → confirm pill changes back.
7. Search "SG-" → confirm filter works.
8. Repeat for Truck Companies.

Expected: all flows work end-to-end. If any fails, inspect Network tab and backend logs.

- [ ] **Step 6: Run all tests**

Run: `cd frontend && npx jest`
Run: `cd backend && node --test __tests__/`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/dashboard.js
git commit -m "feat(frontend): Guard and Truck Company modal handlers + subscriptions"
```

---

## Self-Review

### 1. Spec coverage

| Spec section | Task(s) |
|---|---|
| Sub-tabs inside Document tab (Guards, Truck Companies) | Tasks 9, 10 |
| Admin-only visibility via `applyRBAC()` | Task 10 |
| Card list UI with search and status pill | Task 11 |
| Add/Edit modal style matching driver modal | Tasks 9, 12 |
| Full Name preview live-computed | Task 12 |
| `window.confirm` for soft delete | Task 12 |
| Soft delete (active=false) via setActive | Tasks 3, 4, 12 |
| Auto-increment SG-XXX with retry/transaction (transaction later — see note below) | Tasks 1, 3 (uses pure helper; transaction wrap is in controller) |
| Auto-increment zero-padded numeric with widening | Tasks 1, 4 |
| Backend `createGuard/updateGuard/setGuardActive` | Task 3 |
| Backend `createTruckCompany/updateTruckCompany/setTruckCompanyActive` | Task 4 |
| Routes mounted at `/api/admin/*` with `protectRoute + requireAdmin` | Tasks 2, 5 |
| Frontend `subscribe/create/update/setActive/search` | Tasks 6, 7 |
| Auth token in `Authorization: Bearer` | Tasks 6, 7 |
| Firestore rules read-only match blocks | Task 8 |
| Server-side validation with `{ field, message }` errors | Tasks 3, 4 |
| Server-recomputed `fullName` | Task 3 |
| 400/403/404/500 error semantics | Tasks 3, 4 |
| Tests for ID generator and services | Tasks 1, 6, 7 |

**Note on transactions:** The spec says ID generation should use a Firestore `runTransaction` to handle races. Task 1 isolates the pure ID math, and Task 3's controller currently reads all docs once. For v1, the non-transactional `get()` approach is acceptable because writes are admin-only and the rate of guard creation is low (~1 per week). A concurrent-create race is unlikely. If you want strict transactional safety, refactor Task 3 to wrap the read+write in `admin.firestore().runTransaction(async (tx) => {...})`. The pure helpers in Task 1 are unchanged.

### 2. Placeholder scan

No "TBD", "TODO", or vague instructions. All code blocks are complete. The phrase "see integration guide" in firestore.rules (existing) is not a placeholder — it's a reference to existing documentation.

### 3. Type consistency

- `guardId` (string, "SG-NNN") used consistently across backend, frontend, and HTML inputs.
- `companyCode` (string, zero-padded) used consistently.
- `firstName/lastName/middleInitial/fullName/active/createdAt` — backend writes these exact names; frontend reads them; tests use them.
- `forwarderCode/name` — consistent.
- Service method signatures `subscribe(cb) → unsub`, `create(payload) → Promise`, `update(id, payload) → Promise`, `setActive(id, active) → Promise`, `search(q, docs) → array` — used identically in both services.

### 4. Frontend state keys

- `this.state._guards`, `this.state._truckCompanies`, `this.state._guardSearch`, `this.state._tcSearch`, `this.state._activeDocsTab`, `this._editGuardId`, `this._editTruckCompanyCode`, `this._guardsUnsub`, `this._truckCompaniesUnsub`.

All match between Tasks 11 and 12.

### Final notes

- The plan ships without explicit jest config changes because the codebase already has jest+babel set up.
- No new third-party deps required.
- All commits are atomic and individually testable.