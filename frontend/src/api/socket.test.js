import {beforeEach, expect, test, vi} from 'vitest';

const state = vi.hoisted(() => ({callbacks: [], sockets: [], auth: {currentUser: null}}));
vi.mock('./firebase.js', () => ({auth: {
  get currentUser() { return state.auth.currentUser; },
  onIdTokenChanged: callback => state.callbacks.push(callback),
}}));
vi.mock('./config.js', () => ({API_CONFIG: {SOCKET_URL: 'http://127.0.0.1:8080', DRIVER_TRACKING_URL: 'http://127.0.0.1:8091'}}));
vi.mock('socket.io-client', () => ({io: (_url, options) => {
  const socket = {...options, connected: false, active: false, on: vi.fn()};
  socket.connect = vi.fn(() => { socket.connected = true; socket.active = true; });
  socket.disconnect = vi.fn(() => { socket.connected = false; socket.active = false; });
  state.sockets.push(socket);
  return socket;
}}));

beforeEach(() => {vi.resetModules(); state.callbacks = []; state.sockets = []; state.auth.currentUser = null;});
const user = (uid, token) => ({uid, getIdToken: vi.fn(async () => token)});
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const notify = value => Promise.all(state.callbacks.map(callback => callback(value)));

test('G13/R22 a pending token refresh cannot reconnect either socket after logout', async () => {
  const module = await import('./socket.js'); const driver = module.getDriverSocket();
  driver.connected = driver.active = true;
  const pending = deferred(); const account = user('old', 'old-token'); account.getIdToken.mockReturnValue(pending.promise);
  state.auth.currentUser = account; const refreshing = notify(account);
  state.auth.currentUser = null; await notify(null); pending.resolve('old-token'); await refreshing;
  expect(module.socket.connected).toBe(false); expect(driver.connected).toBe(false);
});

test('G13/R22 logout disconnects immediately while token acquisition is pending', async () => {
  const module = await import('./socket.js'); const driver = module.getDriverSocket();
  module.socket.connected = driver.connected = driver.active = true;
  const pending = deferred(); const account = user('new', 'new-token'); account.getIdToken.mockReturnValue(pending.promise);
  state.auth.currentUser = account; const refreshing = notify(account);
  expect(module.socket.connected).toBe(false); expect(driver.connected).toBe(false);
  pending.resolve('new-token'); await refreshing;
});

test('G13/R22 secondary reconnect keeps a dynamic current-account token callback', async () => {
  const module = await import('./socket.js'); const driver = module.getDriverSocket();
  driver.connected = driver.active = true;
  state.auth.currentUser = user('a', 'token-a'); await notify(state.auth.currentUser);
  state.auth.currentUser = user('b', 'token-b');
  expect(typeof driver.auth).toBe('function');
  expect(await new Promise(resolve => driver.auth(resolve))).toEqual({token: 'token-b'});
});

test('G13/R22 token-provider failures disconnect both sockets without rejected auth listeners', async () => {
  const module = await import('./socket.js'); const driver = module.getDriverSocket();
  module.socket.connected = driver.connected = driver.active = true;
  const account = user('a', 'token-a'); account.getIdToken.mockRejectedValue(Error('synthetic token outage'));
  state.auth.currentUser = account;
  await expect(notify(account)).resolves.toBeDefined();
  expect(module.socket.connected).toBe(false); expect(driver.connected).toBe(false);
});

test('G13/R22 explicit connect cannot apply a token returned after logout', async () => {
  const module = await import('./socket.js'); const pending = deferred();
  const account = user('a', 'token-a'); account.getIdToken.mockReturnValue(pending.promise);
  state.auth.currentUser = account; const connecting = module.connectSocket();
  state.auth.currentUser = null; pending.resolve('old-token'); await connecting;
  expect(module.socket.connect).not.toHaveBeenCalled();
});

test('G13/R22 secondary handshake drops a token returned for a previous account', async () => {
  const module = await import('./socket.js'); const driver = module.getDriverSocket(); const pending = deferred();
  const account = user('a', 'token-a'); account.getIdToken.mockReturnValue(pending.promise);
  state.auth.currentUser = account; const handshake = new Promise(resolve => driver.auth(resolve));
  state.auth.currentUser = user('b', 'token-b'); pending.resolve('old-token');
  expect(await handshake).toEqual({});
});
