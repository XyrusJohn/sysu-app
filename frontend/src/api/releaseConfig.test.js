import {beforeEach, afterEach, test, expect, vi} from 'vitest';
beforeEach(() => {
  vi.resetModules();
  for (const [key, value] of Object.entries({VITE_RELEASE_TARGET: 'local', VITE_API_URL: 'http://127.0.0.1:8080',
    VITE_SOCKET_URL: 'http://127.0.0.1:8080', VITE_DRIVER_TRACKING_URL: 'http://127.0.0.1:8091',
    VITE_FIREBASE_PROJECT_ID: 'demo-sysu-security'})) vi.stubEnv(key, value);
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
test('R32 Vite development proxy uses the explicit local API and primary socket', async () => {
  const imported = await import('../../vite.config.js');
  const config = typeof imported.default === 'function' ? imported.default({command: 'serve', mode: 'test'}) : imported.default;
  expect(config.server.proxy['/api'].target).toBe('http://127.0.0.1:8080');
  expect(config.server.proxy['/socket.io'].target).toBe('http://127.0.0.1:8080');
});
