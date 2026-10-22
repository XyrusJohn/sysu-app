# Container deployment

The repository-root `Dockerfile` builds the Node.js API and Socket.IO service only. The React dashboard remains a static frontend build and can be hosted by any static web server or provider; it is not copied into this API image. Build that frontend with `VITE_API_URL` and `VITE_SOCKET_URL` set to the deployed API origin. The Android application is maintained in `sysu-go` and is distributed as an APK, not as a server container.

## Build and run

Use a host with Docker Engine or another OCI-compatible container runtime. Copy `.env.container.example` to `.env`, set the Firebase project, exact allowed dashboard origins, and the SAP OData URL, then provide credentials using the host's secret manager or workload identity. The sample intentionally contains no credentials.

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f api
```

The default host/container port is `8080`; set `PORT` and `HOST_PORT` in `.env` if needed. The service binds to `0.0.0.0`, serves HTTP and Socket.IO on the same port, and exposes `/health/live` for the image health check. Behind a reverse proxy, set `TRUST_PROXY` to the verified proxy hop count or IP/CIDR. Configure TLS at the host's reverse proxy or ingress.

To build without Compose:

```sh
docker build -t sysu-app-api:local .
docker run --rm --env-file .env -p 8080:8080 sysu-app-api:local
```

Set the matching container `PORT` when publishing a different internal port. Do not bake `.env`, service-account files, or keys into an image. This image is platform-neutral but still depends on reachable Firebase and SAP services and correctly configured origins, credentials, and proxy settings. Horizontal replicas require an explicit Socket.IO scaling strategy (sticky sessions and a shared adapter) before enabling them.

The production API is hosted on Render at `https://sysu-app.onrender.com`; use the root Dockerfile and `/health/live` health check. The same image can run on another OCI-compatible host. A plain LAMP installation without a container runtime cannot run this image directly.


## Render production connections

- SYSU App API and Socket.IO: `https://sysu-app.onrender.com`.
- SYSU Go API and Socket.IO: `https://sysu-go.onrender.com`.
- Dashboard hosting remains `https://sysu-web-5a25d.web.app`; include this origin in `ALLOWED_ORIGINS` on both services.
- Build the web frontend with `VITE_API_URL` and `VITE_SOCKET_URL` pointing to SYSU App and `VITE_DRIVER_TRACKING_URL` pointing to SYSU Go. Rebuild and redeploy Firebase Hosting after endpoint changes.
- Rebuild and install the Android APK after changing its `API_BASE_URL` and `SOCKET_URL`; server environment variables cannot change an installed APK's destinations.
- SYSU Go requires `SYSU_ENV=production`, `FIREBASE_PROJECT_ID=sysu-web-5a25d`, and a valid replacement service-account credential supplied securely by the owner. Production must not have Firebase emulator variables set.
- Backend deployment does not publish the web frontend or distribute an updated Android APK. Health checks only prove process availability; verify authenticated cross-app behavior separately.
