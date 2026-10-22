# Staging deployment

The `staging` branch is for pre-release testing. Its Firebase Hosting site and Firebase project are kept separate from the production Hosting configuration. A separate Hosting domain alone does not isolate Firebase Auth, Firestore, or Storage; the staging frontend and API must both use the `sysu-stage` project.

## Firebase Hosting

The production deployment continues to use `frontend/firebase.json` and the default `sysu-web-5a25d` project. Staging uses `frontend/firebase.staging.json`, the `staging` Hosting target in `frontend/.firebaserc`, and an explicit project argument. The staging predeploy build loads `.env.staging` explicitly so its Firebase and API settings are present in the generated bundle.

From `frontend`, create the Hosting site if it does not already exist, then copy `.env.staging.example` to `.env.staging` and fill it with the `sysu-stage` Web App config and deployed staging API origins:

```powershell
firebase hosting:sites:create sysu-app-staging --project sysu-stage
Copy-Item .env.staging.example .env.staging
firebase deploy --config firebase.staging.json --only hosting:staging --project sysu-stage
```

If the site already exists, skip the create command. The intended site URL is `https://sysu-app-staging.web.app`; add that domain to Firebase Authentication's authorized domains. The staging build uses Vite's `staging` mode and refuses the production Firebase project/auth domain/storage bucket.

The Firebase Web App values are public client configuration. Keep them in the ignored `.env.staging` file or the static site's build environment, not in committed environment files. Never put Firebase Admin credentials in the frontend.

## Staging service requirements

- Deploy the SYSU App API from the `staging` branch as its own Render web service. Set `FIREBASE_PROJECT_ID=sysu-stage`, use a service-account secret created for that project, allow only the staging dashboard origin in `ALLOWED_ORIGINS`, and use a staging-safe SAP endpoint. Set `PORT` to the port configured for the service and verify `TRUST_PROXY` for Render's proxy.
- Set `VITE_API_URL` and `VITE_SOCKET_URL` to that staging API's HTTPS origin.
- Set `VITE_DRIVER_TRACKING_URL` to a staging SYSU Go API. The release config deliberately rejects the production Railway tracking endpoint in staging. Without a staging SYSU Go service, Driver Action history and driver tracking are not a complete staging test.
- Initialize Firebase Auth, Firestore, and Storage as needed in `sysu-stage`; configure the required Auth providers and deploy reviewed Firestore rules/indexes to the staging project before exercising data flows.

Do not use the production Hosting config or default project for staging deploys. Do not deploy app changes to production from this branch.
