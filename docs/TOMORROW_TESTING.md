# Testing setup — 2026-10-09

This workstation uses the existing Firebase project `sysu-web-5a25d`, including its real Auth and database. Web uses the current local sysu-app backend; mobile tracking and the liveTest APK use the existing sysu-go Railway service. Tests and changes made through these clients affect the existing operational data.

## Website

Keep one backend terminal and one frontend terminal open. If the backend is already running under nodemon, reuse it rather than starting a second instance.

```powershell
cd C:\Users\xyver\sysu\sysu-app\backend
npm run dev
```

```powershell
cd C:\Users\xyver\sysu\sysu-app\frontend
npm run dev
```

Open `http://localhost:5173` and refresh the page after restarting Vite. Ignored `.env` files are configured for this workstation; no session environment overrides or Firebase emulators are required. Existing shell `VITE_*` overrides can take precedence over these files; use a fresh terminal if inherited overrides remain.

Verified: website HTTP 200; backend `/health/ready` HTTP 200 with `ready`; resolved Firebase project is existing project; no browser emulator overrides; all 64 frontend tests pass. Release builds still reject localhost endpoints.

## Android

Testing APK: `C:\Users\xyver\sysu\sysu-go\app\build\outputs\apk\liveTest\app-liveTest.apk`.

Build again with `gradlew.bat assembleLiveTest` from sysu-go. This variant uses the existing Firebase and Railway services, with emulator mode disabled. It is signed with this machine's Android debug key for testing. Its application ID remains `com.sysu.go`; update compatibility with an installed APK depends on that APK's signing certificate. Do not uninstall an operational driver app to bypass a signing mismatch; inspect the certificates first.

Verified: liveTest assemble, lint and 42 unit tests pass; APK signature verifies (v2); generated Firebase resource is `sysu-web-5a25d`; generated DEBUG is false and API/socket URLs are the existing sysu-go service.

Phone installation, login and the complete real QR → assignment → location → POD → completion flow have not been executed on a device. The live mobile backend has not been deployed from this worktree, so the new transactional POD route and other server fixes are not yet proven available there. The APK is a testing artifact, not evidence of completed device acceptance or a coordinated backend rollout.
