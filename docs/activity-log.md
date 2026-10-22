# Activity log

## 2026-10-16 â€” Reconcile completed trips out of Overview Live Scans

The assignment snapshot now removes a live row/map marker when its linked trip becomes terminal, even if the driver's completion socket event was missed. Return-to-base assignments remain visible; when one linked shipment completes but another remains active, tracking follows the remaining shipment and ignores late fixes linked to the completed one. Focused lifecycle/map tests passed 92/92; full frontend suite passed 160/160; Vite production build passed; ESLint reported 0 errors and 66 warnings. Local only; no production deployment.

## 2026-10-16 - Grouped Dispatch Details by Ship-To location

Dispatch Details now combines OBDs with matching Ship-To, customer name, delivery address, and normalized coordinates into one summary row with summed cargo metrics. Expanding the row retains individual OBD amounts, POD previews, and delivery outcomes; incomplete location identity stays ungrouped. Focused delivery-filter tests passed 36/36, targeted ESLint had 0 errors and reported 13 warnings, and the Vite production build passed. No production deployment.

## 2026-10-16 — Restore assigned shipment detail fields across status filters

Added an active-staff-only SAP detail projection for existing assignments and merged it into the shared shipment groups used by every status filter. Restored per-OBD amount, volume, weight, Ship-To, delivery address, coordinates, route, planning date, and available delivery date without adding these fields to driver-readable Firestore assignments. Frontend delivery-filter tests passed 34/34; focused backend SAP/scoping/authorization tests passed 19/19. Local only; no production deployment.

## 2026-10-16 — Per-OBD delivery outcome in Dispatch Details

Added Delivery Status beside POD Preview using assignment line-item `deliveryStatus` only when `isPodCompleted` is true. Maps All Delivered to Delivered, preserves Rejected and Delivered w/ rejection, and shows Pending POD or Unknown without guessing. Existing assignment snapshots refresh an open detail modal; the table scrolls horizontally on narrow screens. Focused dashboard tests passed 26/26 and the Vite build passed. No API/schema changes or deployment; live phone-to-web acceptance remains pending.

## 2026-10-14 — Overview map marker lifecycle

Fixed completed-trip marker resurrection from later status-only events and corrected overview reload colors for saved positions: active saved locations await live GPS in violet, while return-to-base remains blue. Completion removes the marker until a new verified active-shipment GPS fix arrives. Validation: frontend 25/25, location-handler review 15/15, production build successful; deployed to Firebase Hosting project `sysu-web-5a25d` and verified dashboard/bundle HTTP 200. No mobile/backend change or operational data write.

## 2026-10-14 — User-requested controlled beta deployment

Deployed the runtime-only mobile own-position controller/route changes to the existing production service; Railway `5c2b152a-714d-46a8-9b33-6f6a3be41afd` SUCCESS. Web source matches its already deployed artifact. Post-deploy health, queue/CORS, both authenticated sockets, private-route anonymous/staff denial and six availability observations pass. Retained exact prior runtime for rollback; APK SHA-256 remains `ff42edc20a4773aa1b976e5603d23708e35281f9dc37762f88b39ba45faa9111`. Three static RELRO checks remain failed; no general release sign-off. No trip/GPS/permission writes, rule/secret/infrastructure edits, commit or push. [Evidence](controlled-beta-deployment-2026-10-14.md).

## 2026-10-14 — Native automation and release regression

Added isolated paired native Kotlin-to-web tests and reproducible runners, with synthetic Firebase fixtures and actual local web/mobile services. After user-approved CameraX/ML Kit updates, native UI/camera 16/16, strict 16 KB runtime smoke 2/2, paired native-to-web 4/4, browser regression 16/16, mobile backend 140/140 and shared local Firestore contracts 29/29 per repository pass; frontend 105/105 and web backend 153/153 passed in this batch. Fixed QR footer test interaction and GPS fixture publication timing. Emulator system/transport failures did not recur after using a 2,048 MB guest and a 384 MB Firestore JVM; final registration HTTP 200 took 887 ms. Three of six static RELRO checks still fail, retained as G-30 IN PROGRESS. [Evidence](automated-release-validation.md). No deployment, commit or push.

## 2026-10-09: phone-to-web tracking

Real browser regressions exposed a first secondary-socket connection lost during token refresh and a fresh GPS fix retaining offline status. Fixed with current-account auth checks preserved. Both tested backends deployed; approved super-admin activation verified. Exact test/deployment evidence and actual-phone acceptance remain in the [canonical tracking plan](live-location-optimization-plan.md#implementation-checkpoint--2026-10-09). No commit/push or rules/dependency changes.


## 2026-10-15 ? Second-brain scan follow-up

Aligned HTTP, socket, QR and staff transaction account checks with explicit active status. Location persistence now reserves in-flight work and backs off empty/failed attempts for 30 seconds while retaining the successful-write movement/time throttle. Validation: 25 focused unit tests passed across authorization, socket, role review and staff driver suites. No production changes or account migration performed; profiles without active status now lose access.


## 2026-10-15 — Documentation navigation refresh

Replaced the outdated long-form root overview with a concise setup and documentation map, corrected the testing-setup pointer, and preserved the former Claude QR plan in the archive. Verified 26 Markdown files have resolvable relative links. The R06 dependency-install workflow and dated production/test evidence remain open for their existing owners. No application code changed; no tests or build were run for this documentation-only update.

## 2026-10-21 -- SAP and assignment empty/error feedback

SAP outages now remain distinct from confirmed empty shipment results: failed refreshes preserve the last successful shipment snapshot, show a retryable alert, and no longer produce a false success notice. SAP status filters/searches render explicit empty messages; Assign flows distinguish unavailable/loading data from genuine no-match results. Dispatch Detail now shows a retryable warning if SAP-only field enrichment fails while preserving saved assignment/POD rows. Frontend tests passed 197/197, Vite production build passed, targeted ESLint had 0 errors and 11 existing warnings, and git diff --check passed. Local only; no deployment, commit, or push.
