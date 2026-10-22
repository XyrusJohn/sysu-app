const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LIVE_HOSTS = new Set(['sysu-app.onrender.com', 'sysu-go.onrender.com']);
const PRODUCTION_ENDPOINTS = Object.freeze({
    VITE_API_URL: 'sysu-app.onrender.com',
    VITE_SOCKET_URL: 'sysu-app.onrender.com',
    VITE_DRIVER_TRACKING_URL: 'sysu-go.onrender.com',
});

/** Keep an emulator-backed test artifact from being mistaken for a public release build. */
export function assertProductionBuildTarget(command, mode, env) {
    if (command === 'build' && mode === 'production' && env.VITE_RELEASE_TARGET !== 'production') {
        throw new Error('Production frontend builds require VITE_RELEASE_TARGET=production; use npm run build:e2e for emulator tests');
    }
}

/** Shared browser/build validation; endpoints never default to a live service. */
export function resolveReleaseConfig(env) {
    const target = env.VITE_RELEASE_TARGET;
    const workstation = target === 'production' && env.DEV === true && env.VITE_USE_LOCAL_BACKEND === 'true';
    if (!['local', 'staging', 'production'].includes(target)) throw new Error('VITE_RELEASE_TARGET must explicitly be local, staging or production');
    const project = env.VITE_FIREBASE_PROJECT_ID;
    if (!project) throw new Error('VITE_FIREBASE_PROJECT_ID is required');
    if (target === 'local' && !project.startsWith('demo-')) throw new Error('Local Firebase project must be a demo project');
    if (target === 'staging' && project === 'sysu-web-5a25d') throw new Error('Staging cannot target the production Firebase project');
    const authDomain = env.VITE_FIREBASE_AUTH_DOMAIN;
    const bucket = env.VITE_FIREBASE_STORAGE_BUCKET;
    if (target === 'local' && authDomain && authDomain !== `${project}.firebaseapp.com`) {
        throw new Error('Local Firebase Auth domain must match the demo project');
    }
    if (target === 'local' && bucket && ![`${project}.appspot.com`, `${project}.firebasestorage.app`].includes(bucket)) {
        throw new Error('Local Firebase Storage bucket must match the demo project');
    }
    if (target === 'staging' && (authDomain === 'sysu-web-5a25d.firebaseapp.com'
        || ['sysu-web-5a25d.appspot.com', 'sysu-web-5a25d.firebasestorage.app'].includes(bucket))) {
        throw new Error('Staging cannot target production Firebase Auth or Storage');
    }
    function endpoint(name) {
        const value = env[name];
        if (!value) throw new Error(`${name} is required`);
        let url;
        try {url = new URL(value);} catch {throw new Error(`${name} must be a valid URL`);}
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
            || url.pathname !== '/' || url.search || url.hash) throw new Error(`${name} must be a service origin`);
        if (target === 'production' && url.hostname !== PRODUCTION_ENDPOINTS[name]) {
            throw new Error(`${name} must use its approved production endpoint`);
        }
        if (target === 'local' && !LOCAL_HOSTS.has(url.hostname)) throw new Error('Local endpoints must use loopback hosts');
        if (target !== 'production' && LIVE_HOSTS.has(url.hostname)) throw new Error('Non-production configuration cannot target live production endpoints');
        const localTestEndpoint = workstation && LOCAL_HOSTS.has(url.hostname);
        if (target !== 'local' && !localTestEndpoint && (url.protocol !== 'https:' || LOCAL_HOSTS.has(url.hostname))) throw new Error(`${name} requires a public HTTPS origin`);
        return url.origin;
    }
    return Object.freeze({BASE_URL: endpoint('VITE_API_URL'), SOCKET_URL: endpoint('VITE_SOCKET_URL'),
        DRIVER_TRACKING_URL: endpoint('VITE_DRIVER_TRACKING_URL')});
}

/** Validate emulator destinations before creating Firebase clients. */
export function resolveLocalEmulators(env) {
    let auth, firestore;
    try {
        auth = new URL(env.VITE_AUTH_EMULATOR_URL);
        firestore = new URL('http://' + env.VITE_FIRESTORE_EMULATOR_HOST);
    } catch {throw new Error('Local Auth and Firestore emulator endpoints are required');}
    for (const url of [auth, firestore]) {
        if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname) || !url.port
            || Number(url.port) < 1 || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            throw new Error('Emulator endpoints must explicitly use loopback HTTP ports');
        }
    }
    return {authUrl: auth.origin, firestoreHost: firestore.hostname, firestorePort: Number(firestore.port)};
}
