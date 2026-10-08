# Controlled beta: SYSU App web and SYSU Go Android

Updated: 2026-10-09. Requested scope: selected real drivers and real shipments in the existing production Firebase database. **Current decision: NO-GO for distributing this new version to real drivers.** Current local fixes have passing automated evidence; deployed compatibility and the required Android workflows are not yet proven.

Canonical finding status lives in [web FIX_TRACKER](FIX_TRACKER.md) and [mobile FIX_TRACKER](../../sysu-go/docs/FIX_TRACKER.md). This document owns the smaller controlled-beta gate, not the full public-release checklist. Executed checks live in each repository's RELEASE_FIXES_TDD.md.

## Minimum before real-data beta

| Gate | Evidence needed | Current gap |
|---|---|---|
| Critical security | Deployed Auth/role/ownership/privacy policy for both backends and shared rules; exposed service-account key invalidated and replacement verified | Local socket/API/rules fixes exist. Deployed policy, real Auth acceptance and G-24 IAM invalidation are unverified |
| Required mobile contracts | Owned profile, location, assignment/OBD progress and POD/Storage work with the reviewed rules; unauthorized writes remain denied | G-16/G-19 location/POD/legacy profile work remains. Strict rules must not be deployed alone |
| Exact deployable versions | Fixed web/backend commits and reviewed production config; Android application ID, version, signing certificate and endpoints match the intended driver update | No new version deployed. Debug is demo-only; current release APK is unsigned. Existing installed APK/signing identity is unknown |
| Compatibility and recovery | Prove current non-pilot clients remain usable or coordinate their upgrade; validate legacy account status/UID/schema and a recovery plan | Both services share a live database. Tightened rules/Auth and retired routes can affect existing clients; emulator success is insufficient |
| One supervised cross-app run | On an actual Android device: approved login → QR admission → staff assignment with multiple OBDs → loading/transit/location → POD → web display → completion; logout/reconnect and denied cross-driver access | No device connected to adb; no actual Android-to-web acceptance run |
| Pilot control | Named driver/staff participants, limited planned shipments, operator observing outcomes, previous APK/web/backend/config and data recovery reference available | Participants, installed version and rollout/recovery owner not recorded |

The beta can start once these gates are proven for its agreed scope. Public-release CI, broader device/accessibility coverage and full load/soak remain on the release trackers; they are not all prerequisites for a small supervised pilot. A broken or unsafe required beta flow cannot be substituted with a disclaimer.

## Rollout order

1. Finish and verify the required mobile contracts locally. Inventory the installed driver's APK and legacy accounts without changing operational data.
2. Rehearse the selected workflow using synthetic data and the exact intended web/backend/Android configuration. Prepare a signed production-configured pilot APK using the correct owner-controlled key; do not give drivers the demo debug APK or the unsigned release APK.
3. Review the coordinated change set, configuration/rules/index versions, client compatibility and recovery procedure. Changes to shared production rules affect all clients, even when only a few drivers participate.
4. Apply the reviewed changes through the release owner's rollout process; verify deployed behavior and the supervised device workflow before allowing further real shipments. Local fixes are not automatically present in the currently deployed system.
5. Begin the small selected cohort and record each shipment outcome. Stop on unauthorized data access, lost/duplicated admission, wrong assignment/OBD, missing POD, crashes blocking work or ambiguous state. Capture identifiers/timestamps and sanitized errors; retain sensitive evidence in the approved operational system.

## Metrics during beta

Collect crashes/ANRs, QR success/conflict/timeout, assignment/progress/POD success, web-update delay, socket reconnect/expiry behavior, API error/latency and device network/battery behavior. Record device/OS/app and server/config versions with each observation. These measurements can be gathered during the supervised pilot; they do not replace the pre-beta security and workflow proof. Agree operating thresholds from the existing operation and the first supervised run rather than inventing unsupported production capacity claims.

No production database, rules, deployment, IAM key, installed driver application or signing configuration has been changed by this local beta-preparation batch.

## 2026-10-09 local fix checkpoint

Production update: [Railway startup recovery](PRODUCTION_RECOVERY_2026-10-09.md) now proves both backend deployments SUCCESS and passing production health/CORS checks. Earlier statements that no Railway changes had been performed refer to the prior local batch; real configuration repair and restarts have now occurred. Firebase Hosting/rules, APK installation and complete authenticated acceptance have not been verified by this recovery.

Workstation startup correction: see [tomorrow's testing setup](TOMORROW_TESTING.md). Web now explicitly supports existing Firebase with a localhost backend only during the opted-in Vite development server; all 64 frontend tests pass. Backend Firebase readiness returns HTTP 200. A separate liveTest mobile APK uses existing Firebase/services with emulators disabled, signed by the machine's debug key; assemble/lint and 42 unit tests pass, and its APK signature verifies. Device acceptance, installed-certificate compatibility and deployment of the matching mobile backend remain unverified.

Latest local evidence is GREEN: sysu-go backend 119/119, shared Firestore profile/location contracts 24/24, atomic POD emulator transaction 1/1, mobile socket lifecycle regressions 2/2, Android session-gate unit test 3/3, and Android debug/release unit tests, lint, and assemble tasks all BUILD SUCCESSFUL. The duplicate rules-function regression found by the first contract run was removed and the suite rerun successfully. These are local/demo-emulator results; deployment, IAM rotation, signing, and actual-device gates remain open.
