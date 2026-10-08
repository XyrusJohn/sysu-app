# Railway production recovery — 2026-10-09

## Warehouse socket regression and production data verification

Incident W-01: server.js destructured getWarehouseBaseConfig/saveWarehouseBaseConfig, but warehouseBaseController defined without exporting them. The shipped socket callback returned the exact `getWarehouseBaseConfig is not a function` error. RED f04e5ee captured 4 failures/3 passes; minimal fix exports both helpers, preserving authorization. Final dedicated tests cover warehouse socket and HTTP reads/writes/denials plus all role-helper exports (10 passing); backend unit regressions 103/103 pass. GREEN commit 19b4bc9.

Uploaded sysu-app current source through Railway up. Deployment fb41db33-08f2-42d0-a06c-ccad930a31ea is SUCCESS. New deployment logs show the server running on 8080; sampled logs contain no warehouse-function error. Production health/readiness and four hosted-origin CORS preflights still pass.

Read-only Admin Firestore counts: users29, drivers21, queue17, sap_assignments12, settings1. Separate browser-facing REST reads with the existing web project's API configuration return HTTP200 and drivers21/queue17/assignments12. Production warehouse setting exists. No records or account roles/status were modified.

A legacy super_admin profile without status was identified, but reading the actual deployed rules disproved the initial hypothesis that it caused this live data issue: currently deployed rules permit these reads without that status check. The stricter local rules have not been deployed. The existing production rules remain a previously tracked security gate; no broad rules rollout was bundled into this incident repair. The user's authenticated browser dashboard rendering and SAP source have not been independently verified by these collection reads.

## Firebase Hosting recovery

The user's `firebase deploy --only hosting` failed before upload because frontend had no `.firebaserc` project mapping. Added default project sysu-web-5a25d. Rebuilt the current frontend with Node 24 (76 modules, successful production configuration validation), then successfully executed `firebase deploy --only hosting --project sysu-web-5a25d` from frontend. Firebase reported release complete. No Firestore rules were included in this deployment.

Live root, dashboard.html and qr-generator.html each return HTTP 200; SHA-256 of each delivered HTML matches the freshly built file exactly. Both Railway health endpoints, sysu-app Firestore readiness and all four hosted-origin CORS preflights were rechecked and still pass after Hosting release. The installed phone APK and complete authenticated shipment flow remain unverified.

Project: splendid-courage (`6caec00e-4b8c-4b50-8d1e-0de2fe67de81`), environment production.

Both services were observed CRASHED after the user's deployments. The startup guards required configuration which the deployed variables did not satisfy. sysu-go lacked SYSU_ENV and FIREBASE_PROJECT_ID; sysu-app included a localhost origin which its production origin guard rejects. Existing credential JSON was present in both services and identified the existing project sysu-web-5a25d. No credential values were printed by the Railway inspection.

Production variables were repaired through the linked authenticated CLI, preserving existing credentials and the existing database. sysu-go now has SYSU_ENV=production, FIREBASE_PROJECT_ID=sysu-web-5a25d and NODE_ENV=production. Its allowed origins include both existing hosted website origins and the existing workstation origins. sysu-app's production allowed origins are exactly https://sysu-web-5a25d.web.app and https://sysu-web-5a25d.firebaseapp.com.

The first CLI origin list lost comma separators under PowerShell argument parsing. This was detected during verification and corrected with quoted arguments before accepting the recovery. The final live CORS checks pass.

Verified production deployments:

| Service | Deployment | State |
|---|---|---|
| sysu-app | 555b3bd7-5b49-48cd-a515-492f3fc8d217 | SUCCESS |
| sysu-go | c6e4e51f-c179-4fa0-addc-bfc3d23a0e31 | SUCCESS |

Verified public responses after these deployments completed:

| Check | Result |
|---|---|
| sysu-app /health/live | 200 live |
| sysu-app /health/ready (actual Firestore read probe) | 200 ready |
| sysu-go /api/health | 200 ok |
| sysu-app OPTIONS from each hosted website origin | 204 with exact matching allow-origin |
| sysu-go OPTIONS from each hosted website origin | 204 with exact matching allow-origin |

This recovers the Railway startup outage. It is not evidence of phone installation, authenticated shipment/POD acceptance, credential rotation, or Firebase Hosting/rules deployment. Variable-triggered deployments reuse the already-uploaded service artifacts; exact source-commit correspondence has not been independently proven. Existing release gates retain their status.
