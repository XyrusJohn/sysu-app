# LAMP / MySQL Migration Assessment

**Date:** 2026-10-16  
**Status:** Assessment only; no database migration or compatibility test has been performed.  
**Scope:** SYSU App web dashboard and API, with cross-project dependencies called out where needed.

## Executive summary

SYSU App is not currently a PHP/MySQL application. It is a React/Vite frontend and a Node.js 24 / Express 5 API. The backend uses Firebase Authentication and Cloud Firestore directly; SAP shipment data is fetched from SAP OData. The repository does not declare a MySQL driver, ORM, SQL schema, or SQL persistence adapter. The existing Firestore collections/tables in the target MySQL instance may be ready as a preliminary schema, but their compatibility with the running system has not been demonstrated.

Porting to a LAMP server therefore involves an application and identity/data architecture change, not just moving existing tables. A LAMP web server can potentially serve the built frontend and proxy the current Node API, but that would not constitute migrating the backend to PHP or application data to MySQL. For a true LAMP/MySQL target, the backend persistence and authentication paths must be redesigned or explicitly bridged, then tested against a representative schema and data set. No production readiness conclusion can be made until those tests pass.

## Current implementation (verified in repository)

- Frontend: React 19 and Vite; Firebase client SDK is used for identity/data-facing flows.
- API: Node.js 24, Express 5, Firebase Admin SDK, Socket.IO and `node-cron`.
- Persistence: Firestore collections include `users`, `drivers`, `queue`, `qr_tokens`, `qr_admissions`, `sap_assignments`, admin configuration/requests, and `id_sequences`. The list is indicative from inspected source and documentation, not an exhaustive schema export.
- Identity: Firebase Authentication issues ID tokens; backend middleware verifies tokens and reads user profiles/roles from Firestore.
- Workflows with database semantics: QR admission and status changes, assignment/queue updates, role management, and sequence-based record creation use Firestore transactions or atomic document operations.
- External data: SAP shipments are read through OData and projected/cached in the backend; they are not simply a Firestore-to-MySQL table copy.
- Existing validation: backend unit/integration/rules tests exercise Firestore behavior and security. The migration runbook covers guarded Firestore-to-Firestore release migrations. Neither is evidence of MySQL compatibility.

## Compatibility status

| Area | Current evidence | MySQL compatibility status |
|---|---|---|
| Table/schema presence | Owner reports MySQL tables already exist; no schema dump was available in this review | Unverified: columns, types, indexes, keys, constraints, collation, nullability, and cardinalities not compared |
| Backend connectivity | Backend manifests contain Firebase Admin but no MySQL driver/ORM | Not implemented/verified in inspected app |
| Data mapping | Firestore documents and nested fields are used directly in controllers/services | Unverified: relational mapping and preservation of document IDs/nested values |
| Transactions/concurrency | Firestore transaction paths and tests exist | Unverified: isolation, locking, atomicity, duplicate prevention, retry behavior |
| Authentication/authorization | Firebase Auth ID tokens plus Firestore profiles/roles | Unverified: identity migration or federated bridge, role mapping, token lifecycle, revocation |
| Realtime updates | Socket.IO events plus Firestore reads/writes | Unverified: event ordering, persistence consistency, reconnect behavior |
| Android integration | Sibling `sysu-go` mobile app depends on Firebase Auth/backend contracts and shared data | Unverified and cross-project; API/data contract changes can break mobile workflows |
| LAMP deployment | Current backend requires Node.js and Socket.IO; frontend can be built as static assets | No PHP backend/LAMP deployment compatibility evidence |

## Main compatibility risks

1. **Data model mismatch:** Firestore documents can contain nested objects, arrays, optional fields, and document IDs. MySQL requires explicit columns/relations or deliberate JSON columns, with decisions about normalization, nulls, uniqueness, and ID preservation.
2. **Transaction semantics:** QR token consumption/admission, queue changes, role updates, and sequential IDs must retain their all-or-nothing and concurrency behavior. A schema that creates the tables is not sufficient proof.
3. **Identity boundary:** Firebase Authentication is separate from Firestore. Moving profile rows to MySQL does not migrate Firebase identities, password credentials, tokens, role checks, or revocation behavior.
4. **Cross-client contract:** The Android app and web app share Firebase-backed workflows. A MySQL transition needs a compatible API or a staged bridge so mobile clients are not silently stranded on old storage behavior.
5. **Realtime and external services:** Socket.IO tracking and SAP OData are separate from relational storage and need end-to-end checks with the replacement API.
6. **Operational safety:** Backups, rollback, dual-write/read strategy, migration reconciliation, least-privilege database accounts, TLS, secret management, and LAMP hosting limits (including long-lived sockets) are not established by the current table inventory.

## Recommended compatibility test plan

Use a dedicated disposable MySQL database and synthetic/redacted records. Do not run migration or destructive tests against production data.

### Gate 1 — Schema and mapping review

- Obtain a sanitized schema-only export and record MySQL server/version, SQL mode, charset/collation, engine, timezone, and relevant configuration.
- Inventory current Firestore collections, document shapes, field optionality, nested arrays/objects, ID formats, and indexes/queries.
- Produce a field-by-field mapping: source path, target table/column, SQL type/length, null/default behavior, key/constraint, transform, and unresolved cases.
- Check foreign keys, unique constraints, indexes for actual query patterns, leading-zero identifiers, decimal precision, timestamps/timezones, Unicode, and JSON-field policy.

### Gate 2 — Adapter and CRUD compatibility

- In an isolated test environment, exercise create/read/update/delete for representative records in every migrated repository/table.
- Verify prepared statements, connection/pool failure handling, transaction rollback, duplicate keys, FK violations, large payloads, and reconnect behavior.
- Compare API output before/after mapping for field names, missing/null values, IDs, ordering, and pagination.

### Gate 3 — Critical workflow and concurrency parity

- QR token: concurrent scans, single-use consumption, expiry, retries, and no duplicate queue admission.
- Queue/assignment: simultaneous status changes, assignment ownership, ordering, cancellation, and recovery after partial failures.
- Sequential IDs: concurrent creation, legacy maximum seeding, restart, and collision behavior.
- Roles/users: authorization denial and allowed role transitions, including revocation/stale-token behavior.
- POD and location: ownership checks, timestamps, rapid updates, reconnects, and persisted-state consistency.
- Socket/API integration: event ordering, reconnect, and API reads matching committed database state.
- Cross-app: run the shared Android/web registration-to-assignment-to-trip/POD scenarios on matching API versions.

### Gate 4 — Data reconciliation, resilience, and deployment

- Load a representative synthetic dataset; compare source/target record counts and deterministic field-level checksums, including unresolved rows.
- Inject interruption and retry; demonstrate idempotent resume and reviewed rollback/restore from backup.
- Measure query latency and connection use at expected peak concurrency; run backup/restore and failover drills.
- Validate LAMP deployment, HTTPS, secrets, least-privilege DB user, logs without sensitive payloads, health checks, and Socket.IO proxy/timeouts if the Node service remains.
- Require product/operations sign-off for cutover, freeze window, rollback triggers, and post-cutover monitoring.

## Recommended decision and next steps

1. Confirm the intended target: (A) keep Node/Express and move hosting to a LAMP machine while retaining Firebase, or (B) port the backend and persistence to PHP/MySQL. These are materially different plans.
2. For option B, provide a sanitized MySQL schema-only export and identify the source-of-truth Firebase project/data collections. Review the schema mapping before changing application code.
3. Build a compatibility matrix and disposable integration harness for MySQL, starting with the highest-risk transactional workflows above.
4. Keep the current system authoritative until parity, data reconciliation, cross-app acceptance, backup/restore, and rollback gates are signed off. Then prepare a separate staged cutover proposal.

## Evidence limits

This assessment reviewed maintained SYSU App documentation and selected backend configuration, controllers/services, manifests, and test inventory. It did not inspect the user's MySQL instance, obtain its schema, connect to Firebase/SAP/production, perform a data export, or run compatibility tests. Table existence and schema correctness are based only on the owner's statement. Existing Firestore test counts in project status notes are dated, scoped automation results and do not imply MySQL compatibility.
