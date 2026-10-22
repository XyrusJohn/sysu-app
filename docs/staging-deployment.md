# Staging deployment

The `staging` branch is for pre-release testing. Its Firebase Hosting site and Firebase project are kept separate from the production Hosting configuration. A separate Hosting domain alone does not isolate Firebase Auth, Firestore, or Storage; the staging frontend and API must both use the `sysu-stage` project.

## Firebase Hosting

The production deployment continues to use `frontend/firebase.json` and the default `sysu-web-5a25d` project. Staging uses `frontend/firebase.staging.json`, the `staging` Hosting target in `frontend/.firebaserc`, and an explicit project argument. Vite's staging mode automatically loads `.env.staging` so its Firebase and API settings are present in the generated bundle.

From `frontend`, create the Hosting site if it does not already exist, then copy `.env.staging.example` to `.env.staging` and fill it with the `sysu-stage` Web App config and deployed staging API origins:

```powershell
firebase hosting:sites:create sysu-stage --project sysu-stage
Copy-Item .env.staging.example .env.staging
firebase deploy --config firebase.staging.json --only hosting:staging --project sysu-stage
```

If the site already exists, skip the create command. The site URL is `https://sysu-stage.web.app`; add that domain to Firebase Authentication's authorized domains. The staging build uses Vite's `staging` mode and refuses the production Firebase project/auth domain/storage bucket.

The Firebase Web App values are public client configuration. Keep them in the ignored `.env.staging` file or the static site's build environment, not in committed environment files. Never put Firebase Admin credentials in the frontend.

## Staging service requirements

- The `sysu-stage` project's default Firestore database has been created in `nam5` (US multi-region), using the location selected by the project owner. Firestore does not allow changing a database's region after creation. The Cloud Firestore API is enabled, and the repository's reviewed rules and composite indexes have been deployed from `frontend`:

  ```powershell
  firebase deploy --config firebase.staging.json --only firestore --project=sysu-stage
  ```

  Firestore automatically maintains single-field indexes, so only required composite indexes are kept in `firestore.indexes.json`. No production records were copied.
- Configure Firebase Authentication in `sysu-stage` with the providers used by the web app and add `sysu-stage.web.app` to authorized domains. Use synthetic staging accounts and seed the required active `users/{uid}` role documents in the staging database; never copy production accounts or records to make staging work.

- Create/sync the root `render.yaml` Blueprint from the `staging` branch to create the separate `sysu-app-staging-api` Render web service in Singapore. Its `/health/ready` check requires working staging Firestore credentials before Render marks the deployment ready. Supply a service-account JSON from `sysu-stage` through the secret prompt and a staging-safe SAP URL; never use production credentials or a production SAP endpoint. The Blueprint restricts CORS to `https://sysu-stage.web.app`, sets `FIREBASE_PROJECT_ID=sysu-stage`, and configures one trusted Render proxy hop. Render injects the service's `PORT`.
- Set `VITE_API_URL` and `VITE_SOCKET_URL` to that staging API's HTTPS origin.
- Set `VITE_DRIVER_TRACKING_URL` to a staging SYSU Go API. The release config deliberately rejects the production Railway tracking endpoint in staging. Without a staging SYSU Go service, Driver Action history and driver tracking are not a complete staging test.
- Initialize Firebase Auth, Firestore, and Storage as needed in `sysu-stage`; configure the required Auth providers and deploy reviewed Firestore rules/indexes to the staging project before exercising data flows.

Do not use the production Hosting config or default project for staging deploys. Do not deploy app changes to production from this branch.
