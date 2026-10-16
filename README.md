# SYSU Fleet Management Platform

SYSU App provides the web dashboard and kiosk for shipment dispatch, driver queues, and fleet tracking. The Android driver app and its mobile backend are maintained in the sibling [sysu-go](../sysu-go/) repository.

## Description

The web application combines a React dashboard with an Express API. The API integrates Firebase services and SAP shipment data. Current behavior and release status are documented separately; a recorded test or deployment result applies only to its dated scope.

## Leading Features

- Dashboard views for drivers, SAP shipments, assignments, and queue activity.
- Queue and tracking views that receive backend updates.
- Backend APIs for authentication, SAP access, queue operations, and real-time events.

See the [frontend guide](docs/frontend-guide.md) and [backend API guide](docs/backend-api-guide.md) for the reviewed implementation scope.

## Technologies

- Frontend: React 19, Vite, Firebase, Leaflet, and Tailwind CSS.
- Backend: Node.js 24, Express 5, Firebase Admin, and Socket.IO.
- Data and identity: Firebase Authentication and Cloud Firestore.

Versions and scripts are declared in the root, `frontend/`, and `backend/` package manifests. The [release tracker](docs/FIX_TRACKER.md) records the current dependency-installation validation work (R06); check it before choosing an install root.

## Necessary

- Node.js 24 and npm.
- Access to the Firebase and SAP environments required by the workflow being exercised.

## Installation and Configuration

Dependency ownership spans multiple package manifests, and the clean-install workflow is still being validated. Consult R06 in the [release tracker](docs/FIX_TRACKER.md) before installing dependencies. Configure only the required environment-variable names and local endpoints described in the frontend and backend guides; never place real credentials in examples or source control.

## How to Run

The frontend and backend provide `dev` scripts in their respective package manifests. Confirm the dependency installation root and environment configuration first, then see the [frontend guide](docs/frontend-guide.md) and [backend API guide](docs/backend-api-guide.md) for component-specific setup.

## Challenges

Configured checks include:

- Frontend: `npm --prefix frontend test`, `npm --prefix frontend run build`.
- Backend: `npm --prefix backend test`.
- Repository lint: `npm run lint`.

These commands describe available scripts, not a claim that they passed in this documentation update. See [automated release validation](docs/automated-release-validation.md) for dated results and limitations.

## Structure of the Project

```text
backend/   Express API, Firebase integration, and backend tests
docs/      Current guides, acceptance tracking, dated evidence, and archive
frontend/  React dashboard, kiosk, and frontend tests
```

The Android application is in the sibling `sysu-go` repository.

## How to Troubleshoot

Check the [project status summary](docs/project-status-summary.md) and [fix tracker](docs/FIX_TRACKER.md) first. For backend routes and configuration requirements, see the [backend API guide](docs/backend-api-guide.md). The [testing setup note](docs/TOMORROW_TESTING.md) is a safety pointer, not a verified workstation recipe; the [migration runbook](docs/MIGRATION_RUNBOOK.md) applies only to approved, explicitly targeted data migrations.

## Notes

The [documentation index](docs/README.md) links maintained guides and historical records. See the [security policy](SECURITY.md) for security scope and source links. Dated deployment, test, and assessment documents are evidence for their recorded scope, not current production guarantees. Older planning and release records are preserved under [docs/archive](docs/archive/README.md).
