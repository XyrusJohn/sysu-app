# SYSU-App & Ecosystem — Master Production & Readiness Backlog
> Huling Na-update: 2026-10-07 | Branch: `feature/admin-module-enhancements`
> Kasama ang: `sysu-app` (Web + Backend) at Cross-App Integration sa `sysu-go` (Android)

---

## 🎯 Overall Score: 6.0/10 — Functional, May Ilang Critical Crash/Integration Gaps

---

## ✅ Ano ang Gumagana Na (Confirmed Working)
- **FIFO Dispatch Core:** Server-authoritative logic sa `queueOrdering.js` (17/17 tests passing).
- **SAP Live Data:** Live fetch + 60s cache + 60s timeout fallback.
- **Overview & Tracking Map:** Leaflet + OpenStreetMap (walang API key error) + dark monochrome CSS filter.
- **POD & Guard Signature Preview:** Binabasa ang `sap_assignments/{key}/pod_images/{obd}` subcollection at `guardSignatureBase64`.
- **Security & RBAC:** Helmet, Rate Limiters, CORS whitelist, Firebase Auth token validation sa routes.
- **Cron Jobs:** Scheduler para sa QR tokens, queue, at incident cleanups.

---

## 🔴 CRITICAL BLOCKERS (Unahin Bago ang Release / Pilot)

### 1. Crash Bug sa `decideCancelAssignment` (`ReferenceError`)
- **File:** [`backend/src/controllers/sapAssignmentController.js`](file:///C:/Users/xyver/sysu/sysu-app/backend/src/controllers/sapAssignmentController.js#L445)
- **Problema:** Typo `remainingHShipments` sa halip na `remainingShipments`.
- **Epekto:** Mag-500 server crash ang backend kapag inaprubahan ng admin ang shipment cancellation.
- **Fix:** Palitan ng `remainingShipments`.

### 2. `pod_updated` Socket Event Hindi Pinapakinggan ng Dashboard
- **Files:** [`frontend/src/pages/dashboard.js`](file:///C:/Users/xyver/sysu/sysu-app/frontend/src/pages/dashboard.js), [`backend/src/server.js`](file:///C:/Users/xyver/sysu/sysu-app/backend/src/server.js#L424)
- **Problema:** Nag-e-emit ang `sysu-go` ng `pod_updated`, ibinabato ng backend sa socket, pero walang `socket.on("pod_updated")` ang web dashboard.
- **Epekto:** Kailangan pang i-refresh ng dispatcher ang page para makita ang bagong gawang POD.
- **Fix:** Maglagay ng listener sa `dashboard.js` para mag-trigger ng instant UI update sa shipment row.

### 3. Missing `npm test` Script sa Frontend
- **File:** [`frontend/package.json`](file:///C:/Users/xyver/sysu/sysu-app/frontend/package.json)
- **Problema:** May 5 test files (`dashboard.test.js`, `PodPreview.test.js`, atbp.) pero walang `"test"` script sa `package.json`.
- **Epekto:** Walang automated testing sa frontend; bulag ang CI/CD sa frontend regressions.
- **Fix:** I-setup ang test runner (Vitest/Jest) sa `frontend/package.json` at i-verify ang test suites.

### 4. 80 Debug `console.log` Statements sa `dashboard.js`
- **File:** [`frontend/src/pages/dashboard.js`](file:///C:/Users/xyver/sysu/sysu-app/frontend/src/pages/dashboard.js)
- **Problema:** Nagkalat ang debug telemetry sa production build.
- **Fix:** Alisin o i-wrap sa `if (import.meta.env.DEV)`.

### 5. Content Security Policy (CSP) Naka-disable
- **File:** [`backend/src/server.js`](file:///C:/Users/xyver/sysu/sysu-app/backend/src/server.js#L50)
- **Problema:** `helmet({ contentSecurityPolicy: false })`.
- **Fix:** I-configure ang whitelist ng CSP directives (Firebase, OSM, Socket.IO, fonts).

---

## 🟡 HIGH PRIORITY (Bago Mag-Full Unsupervised GA)

### 6. Zero Integration Tests sa `sapAssignmentController.js`
- **File:** `backend/src/controllers/sapAssignmentController.js`
- **Problema:** 520 lines ng critical dispatch logic pero walang integration tests para sa:
  - Driver assignment (happy path)
  - FIFO bypass override approval
  - Assignment cancellation workflow
- **Fix:** Gumawa ng integration tests gamit ang fake Firestore/Node test runner.

### 7. Walang Error Monitoring (Sentry)
- **Problema:** Walang error observability kapag may uncaught exception sa production.
- **Fix:** I-integrate ang Sentry sa backend at frontend gamit ang Railway/Firebase env vars.

### 8. Walang UI Empty States / Error Toasts
- **Problema:** Blankong panel ang lumalabas kapag walang shipments o nag-fail ang Firestore/SAP fetch.
- **Fix:** Maglagay ng user-friendly warning toasts at "No records found" components.

---

## 🟢 TECHNICAL DEBT (Pampaganda ng Codebase)

### 9. Monolithic `dashboard.js` (7,390 lines)
- **Problema:** Lahat ng view, socket listener, at modals ay nasa iisang file.
- **Fix:** I-refactor at i-split sa magkakahiwalay na modular components (`ShipmentTable.js`, `LiveScansPanel.js`, etc.).

### 10. Dual Socket Connection Architecture
- **Problema:** Ang web app ay kumokonekta sa dalawang magkahiwalay na Socket.IO servers (`sysu-app` backend at `sysu-go` backend).
- **Fix:** I-unify ang gateway o panatilihing documented ang separation of concerns.

---

## 📋 Hakbang Kapag Handa Ka Nang Magpaayos:

```
Hakbang 1 ➔ Fix #1: Itama ang `remainingHShipments` typo sa sapAssignmentController.js (~2 min)
Hakbang 2 ➔ Fix #2: Ikabit ang `pod_updated` socket handler sa dashboard.js (~15 min)
Hakbang 3 ➔ Fix #4: Linisin ang 80 debug console.logs sa dashboard.js (~10 min)
Hakbang 4 ➔ Fix #5: I-configure ang Helmet CSP headers (~15 min)
Hakbang 5 ➔ Fix #3: I-setup ang npm test sa frontend (~30 min)
Hakbang 6 ➔ Fix #6: Magdagdag ng controller tests sa backend (~1 hr)
```

---

## 🔗 Kaugnay na mga Dokumento
- [`sysu-go/TODO_BUGS.md`](file:///C:/Users/xyver/sysu/sysu-go/TODO_BUGS.md) — Bug checklist para sa Android app
- [`sysu-go/SYSU_GO_ASSESSMENT.md`](file:///C:/Users/xyver/sysu/sysu-go/SYSU_GO_ASSESSMENT.md) — Technical audit ng Android app
- [`CROSS_APP_TESTING_ASSESSMENT.md`](file:///C:/Users/xyver/sysu/sysu-app/CROSS_APP_TESTING_ASSESSMENT.md) — Buong cross-app testing report
