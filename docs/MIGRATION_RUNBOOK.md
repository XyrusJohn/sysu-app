# SYSU migration v2 runbook

Historical implementation and local evidence are documented here. Recheck current source, tests, target isolation, and approvals before any future run. This document does not authorize a migration or establish production readiness. Current release status: [FIX_TRACKER](FIX_TRACKER.md).

The existing CLI filenames now delegate to the version 2 runner in `backend/src/migrations/releaseMigration.js`. Historical implementations remain in Git. Install backend dependencies from `backend/package-lock.json`; the CLI does not depend on an accidental root Firebase install.

## Target and default mode

Set `FIREBASE_PROJECT_ID` and the independently asserted `MIGRATION_PROJECT_ID` to the same intended project. Missing or mismatched targets fail before initialization. The default mode is `dry-run`; legacy `DRY_RUN=false` alone never enables writes. Credentials must match the target project under the normal backend initialization guard. Local emulator targets require a `demo-` project and loopback ports. Production rejects emulator configuration.

For the synthetic local example, use `demo-sysu-security`, Firestore `127.0.0.1:8085`, and the isolated emulator. Execute either `node scripts/migrate-obd-lineitems.js` or `node scripts/migrate-sap-assignments-driver-uid.js`. A UID dry-run also checks Firebase Auth identities, so configure the isolated Auth emulator at `127.0.0.1:9099` and seed the required synthetic identities. Do not connect a demo migration to a live Auth service.

Review dry-run counts and unresolved records before an apply. Unresolved data is retained. Line items require explicit customer names and positive finite quantities; truckCompany is never a substitute. Mixed arrays are checked item by item and leading-zero OBD identifiers are preserved. Unknown fields are retained except the deliberately removed legacy `amount` field. UID conversion requires an existing canonical Auth identity and unambiguous queue mapping; absent trip status is filled only from matching pre-transit queue membership. Missing evidence requires reconciliation.

## Apply and recovery evidence

Apply requires all of `MIGRATION_MODE=apply`, `MIGRATION_CONFIRM_PROJECT` exactly matching the asserted project, and a unique bounded `MIGRATION_RUN_ID` (letters, digits, underscore or hyphen, at most 80 characters). Record target, artifact commit, migration kind/version, operator, dry-run output, and approval in the release evidence. No production apply has been performed in this task.

The runner reads pages of 100 records. Each changed document is re-read in a transaction; a create-only before image and the source update commit together. Before images are stored under `_migration_runs/{runId}/records/{assignmentId}` with the source path/update time, kind and version. Current application rules have no client grant for these records. Treat backups as private operational data and retain them under the approved backup policy.

A page cursor is persisted only after that page completes. On failure, retain the same target, kind, version and run ID. Rerun from the beginning for the simplest safe resume; already transformed documents remain unchanged, and existing backups cannot be overwritten. For a deliberately verified completed-page checkpoint, `MIGRATION_START_AFTER` accepts its document ID. Do not skip an unresolved or partially completed page. The summary describes the latest invocation, not cumulative counts across attempts; reconcile against actual source documents and backup records.

Exit status 0 means the invocation completed without unresolved records, 2 means reconciliation is required, and 1 means failure. A failure is not reported as success. Capture counts and cursor privately; the CLI does not print raw credentials or line-item/customer payloads.

Restoration must be a reviewed forward repair: compare the current document with its migration result and subsequent operational changes, then restore only approved fields from the before image under a transaction/precondition. Do not overwrite an entire active assignment blindly. Before-image availability is verified locally; a production-size staged repair/restore drill, checksum manifest, backup retention/access ownership, real Auth identity checks and concurrent operational-write drill remain required. Oversized/ambiguous records need individual reconciliation; no blanket restore-readiness claim.

## Local evidence, 2026-10-08

RED `a2e0ec1`: nine failures reproduced unsafe targets/default writes, skipped mixed arrays, customer guessing and invalid-quantity coercion. GREEN unit suite 9/9. Isolated Firestore `demo-sysu-security` suite 5/5: 501-record dry-run/apply/backups/rerun, injected write interruption and safe resume, unresolved data preservation, proven UID conversion and ambiguous identity/state rejection. UID identity lookup is injected in this suite; real Auth emulator/staging identity acceptance remains outstanding. No real production data was used.
