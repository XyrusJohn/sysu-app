import {beforeEach, afterEach, test, expect, vi} from 'vitest';
vi.mock('firebase/app', () => ({initializeApp: vi.fn(() => ({}))}));
vi.mock('firebase/auth', () => ({getAuth: vi.fn(() => ({})), connectAuthEmulator: vi.fn(), GoogleAuthProvider: class {}}));
vi.mock('firebase/firestore', () => ({getFirestore: vi.fn(() => ({})), connectFirestoreEmulator: vi.fn()}));
beforeEach(() => {
  vi.resetModules();
  for (const [key, value] of Object.entries({VITE_RELEASE_TARGET: 'local', VITE_API_URL: 'http://127.0.0.1:8080',
    VITE_SOCKET_URL: 'http://127.0.0.1:8080', VITE_DRIVER_TRACKING_URL: 'http://127.0.0.1:8091',
    VITE_FIREBASE_PROJECT_ID: 'demo-sysu-security', VITE_FIREBASE_AUTH_DOMAIN:'demo-sysu-security.firebaseapp.com',
    VITE_FIREBASE_STORAGE_BUCKET:'demo-sysu-security.appspot.com', VITE_AUTH_EMULATOR_URL: '', VITE_FIRESTORE_EMULATOR_HOST: ''})) vi.stubEnv(key, value);
});
afterEach(() => {vi.unstubAllEnvs();});
test('R32 missing endpoints fail before any silent production fallback', async () => {
  vi.stubEnv('VITE_API_URL', '');
  await expect(import('./config.js')).rejects.toThrow(/VITE_API_URL/);
});
test('R32 local mode cannot target a live production API', async () => {
  vi.stubEnv('VITE_API_URL', 'https://sysu-app-production.up.railway.app');
  await expect(import('./config.js')).rejects.toThrow(/local|production/i);
});
test('R32 local mode cannot initialize the production Firebase project', async () => {
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'sysu-web-5a25d');
  await expect(import('./config.js')).rejects.toThrow(/demo|project/i);
});
test('R32 explicit isolated API and both socket endpoints are preserved', async () => {
  const {API_CONFIG} = await import('./config.js');
  expect(API_CONFIG).toEqual({BASE_URL: 'http://127.0.0.1:8080', SOCKET_URL: 'http://127.0.0.1:8080', DRIVER_TRACKING_URL: 'http://127.0.0.1:8091'});
});
test('R32 local configuration rejects an inherited live Storage bucket', async () => {
  vi.stubEnv('VITE_FIREBASE_STORAGE_BUCKET','sysu-web-5a25d.firebasestorage.app');
  await expect(import('./config.js')).rejects.toThrow(/bucket|storage|production/i);
});
test('R32 local configuration rejects an inherited live Auth domain', async () => {
  vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN','sysu-web-5a25d.firebaseapp.com');
  await expect(import('./config.js')).rejects.toThrow(/domain|auth|production/i);
});
test('R32 Vite development proxy uses the explicit local API and primary socket', async () => {
  const imported = await import('../../vite.config.js');
  const config = typeof imported.default === 'function' ? imported.default({command: 'serve', mode: 'test'}) : imported.default;
  expect(config.server.proxy['/api'].target).toBe('http://127.0.0.1:8080');
  expect(config.server.proxy['/socket.io'].target).toBe('http://127.0.0.1:8080');
});
test('R32 Firebase initialization validates target before creating any SDK clients', async () => {
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'sysu-web-5a25d');
  const {initializeApp} = await import('firebase/app');
  initializeApp.mockClear();
  await expect(import('./firebase.js')).rejects.toThrow(/demo|project/i);
  expect(initializeApp).not.toHaveBeenCalled();
});
test('R32 local SDK initialization requires explicit loopback emulators', async () => {
  await expect(import('./firebase.js')).rejects.toThrow(/emulator/i);
});
test('R32 local SDK clients connect to both explicit emulators', async () => {
  vi.stubEnv('VITE_AUTH_EMULATOR_URL', 'http://127.0.0.1:9099');
  vi.stubEnv('VITE_FIRESTORE_EMULATOR_HOST', '127.0.0.1:8085');
  const {connectAuthEmulator} = await import('firebase/auth');
  const {connectFirestoreEmulator} = await import('firebase/firestore');
  connectAuthEmulator.mockClear(); connectFirestoreEmulator.mockClear();
  await import('./firebase.js');
  expect(connectAuthEmulator).toHaveBeenCalledWith(expect.anything(), 'http://127.0.0.1:9099', {disableWarnings: true});
  expect(connectFirestoreEmulator).toHaveBeenCalledWith(expect.anything(), '127.0.0.1', 8085);
});
