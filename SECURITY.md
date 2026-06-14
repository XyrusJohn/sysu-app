# Security Policy

> **Responsible disclosure:** If you find a security vulnerability, please report it to the maintainers rather than disclosing it publicly. We will work with you to address it.

---

## Supported Versions

| Version  | Supported          |
| -------- | ------------------ |
| `>= 1.0` | :white_check_mark: |

---

## Reporting a Vulnerability

**Do not file public GitHub issues for security vulnerabilities.**

If you discover a security issue, please:
1. **Do not** disclose it publicly
2. Contact the maintainers privately
3. Include as much detail as possible (steps to reproduce, impact assessment)

We aim to acknowledge within 48 hours and provide a fix timeline based on severity.

---

## Known Vulnerabilities & Remediation Status

> Last updated: 2026-05-10

| ID   | Severity | Description                                                  | Status    |
|------|----------|--------------------------------------------------------------|-----------|
| C1   | Critical | QR tokens used `Math.random()` — cryptographically weak      | Fixed     |
| C2   | Critical | QR routes had no authentication (generate/verify/scan)      | Fixed*    |
| H1   | High     | SAP SSL verification was toggleable via `SAP_SSL_VERIFY` env | Fixed     |
| H2   | High     | Role assignment accepted arbitrary strings, bypassing RBAC   | Fixed     |
| H4   | High     | Socket.IO accepted unauthenticated connections               | Fixed     |
| M1   | Medium   | SAP error responses exposed internal `error.message`        | Fixed     |
| M3   | Medium   | CORS wildcard `*` with `Credentials: true` was the fallback | Fixed     |
| L1   | Low      | `helmet` middleware was installed but never applied          | Fixed     |
| L2   | Low      | No graceful shutdown handling                                | Fixed     |
| L5   | Low      | No route-specific rate limits                                | Fixed     |

*QR routes are intentionally public (no auth) as they form a driver self-service queue system. See [QR Token Security](#qr-token-security) below.

---

## Security Architecture

### Authentication
- All `/api/auth` endpoints require a valid Firebase ID token in the `Authorization: Bearer <token>` header
- The `protectRoute` middleware validates tokens using Firebase Admin SDK
- Socket.IO connections are authenticated on handshake via Firebase token verification

### Authorization (RBAC)
Roles are stored in Firestore under `users/{uid} → role`:

| Role            | Capabilities                                          |
| --------------- | ----------------------------------------------------- |
| `super_admin`   | Everything + user management + deletion             |
| `admin`         | Dashboard, SAP, driver management, role assignment   |
| `fleet_manager` | Dashboard, SAP, driver management                    |
| `pending`       | No dashboard access — shown pending approval screen  |

Role changes enforce a hierarchical model — only `super_admin` can assign `super_admin`; only `super_admin` can delete users.

### Rate Limiting

The backend applies three tiers of rate limiting:

| Limiter       | Route            | Limit              | Window    |
| ------------- | ---------------- | ------------------ | --------- |
| Global        | All routes       | 100 requests       | 15 min/IP |
| Auth          | `/api/auth/*`    | 15 requests        | 15 min/IP |
| QR            | `/api/qr/*`      | 30 requests        | 1 min/IP  |

### QR Token Security

QR token endpoints (`/api/qr/generate`, `/api/qr/verify`, `/api/qr/scan`) are **intentionally unauthenticated** because they form a self-service queue system where:

1. The warehouse QR screen generates a cryptographically random token and displays it as a QR code
2. A driver scans the QR with their phone's camera
3. The phone's browser calls `/api/qr/verify` and `/api/qr/scan` to join the queue

This design prevents the need for a driver to log in just to scan a QR code. The token itself is the secret — it expires in 5 minutes and is single-use. The `SYS-` prefix is informational only (identifies the token as a valid SYSU queue token), and tokens are 96-bit cryptographically random hex strings.

### Security Headers (Helmet)

The server applies `helmet` middleware which sets:

| Header                   | Value              |
| ------------------------ | ------------------ |
| `X-Content-Type-Options` | `nosniff`          |
| `X-Frame-Options`        | `DENY`             |
| `Strict-Transport-Security` | Varies          |

CSP is disabled because the legacy frontend uses inline scripts.

### CORS Policy

Origins are controlled by the `ALLOWED_ORIGINS` environment variable (comma-separated). Requests from origins not in the allowlist receive `Access-Control-Allow-Origin: ""` (no CORS). Credentials require an explicit origin match — the old wildcard `*` fallback with `Credentials: true` has been removed (browsers reject that combination anyway).

### Input Validation

- Request bodies are limited to 10KB via `express.json({ limit: "10kb" })`
- QR driver names are sanitized: max 100 chars, angle brackets `<>` stripped
- User role values are validated against `['admin', 'fleet_manager', 'pending']` — arbitrary strings are rejected with 400
- SAP proxy does not accept or forward user-supplied URLs

---

## Dependency Policy

Run `npm audit` in both `frontend/` and `backend/` regularly. Critical and high-severity vulnerabilities should be addressed within 7 days of a patched version being available.

Current minimum versions enforced in package.json:
- `firebase` >= 12.13.0
- `vite` >= 8.1.0
- `axios` >= 1.18.0
- `helmet` >= 8.1.0 (applied in server.js)

---

## Environment Variables Reference

See `backend/.env.example` for full documentation. Key security-relevant variables:

| Variable          | Purpose                                              | Required |
| ----------------- | ---------------------------------------------------- | -------- |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist                       | Yes      |
| `TRUST_PROXY`     | Number of reverse proxy hops for correct IP logging | Yes      |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase admin credentials         | Yes      |
| `SAP_URL`         | SAP OData endpoint                                   | Yes      |
| `NODE_ENV`        | Set to `production` in deployed environments          | Yes      |
| `SAP_SSL_VERIFY`  | **Removed** — SSL is always verified for SAP calls  | N/A      |