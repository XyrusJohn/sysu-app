// Explicit review command; evaluates current handlers with synthetic input and no network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../src/components/MapTrackingPanel.js'), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'Review fixture must find actual handler boundaries');
  return source.slice(from, to).replace(/^export /gm, '');
};
const handlerSource = [
  section('function _subscribeFirestoreDriverLocations()', 'export async function connectDriverTrackingSocket'),
  section('function _wireDriverSocket()', 'function _onConnect()'),
  section('function _removeDriver(driverId)', 'function _upsertMarker('),
  section('export function destroyTrackingPanel()', 'function _esc('),
].join('\n');
const now = Date.now();
const policy = fs.readFileSync(path.resolve(__dirname, '../../src/components/locationState.js'), 'utf8').replace(/^export /gm, '');
function fixture() {
  const meta = new Map(), markers = {}, events = new Map();
  let snapshot, unsubscribed = 0, disconnected = false;
  const socket = {
    on(event, handler) { if (!events.has(event)) events.set(event, new Set()); events.get(event).add(handler); },
    off(event, handler) { if (handler) events.get(event)?.delete(handler); else events.delete(event); },
    disconnect() { disconnected = true; },
  };
  const context = {
    _driverMeta: meta, _markerStore: markers, _driverSocket: socket, _firestoreUnsub: null,
    _closedTrips: new Map(), _freshnessTimer: null, GPS_STALE_MS: 45000, clearInterval() {},
    _connStatus: 'connected', MARKER_STORE_KEY: '__trackingMarkers', window: {}, db: {},
    Date: class extends Date { static now() { return now; } },
    console: {log() {}, warn() {}, error() {}}, collection() { return {}; },
    onSnapshot(_ref, handler) { snapshot = handler; return () => { unsubscribed++; }; },
    _onConnect() {}, _onDisconnect() {}, _onConnectError() {}, _refreshDriverList() {},
    _upsertMarker(id, lat, lng, status) { markers[id] = {lat, lng, status}; },
    updateMarker(value) { markers[value.driverId] = value; },
    removeMarker(id) { delete markers[id]; },
  };
  vm.createContext(context); vm.runInContext(policy + "\n" + handlerSource, context);
  return {
    context, meta, markers, events, socket,
    move: value => context._onDriverMoving(value), status: value => context._onDriverStatus(value),
    subscribe() { context._subscribeFirestoreDriverLocations(); },
    firestore(data, type = 'modified') { assert.ok(snapshot); snapshot({docChanges: () => [{type, doc: {id: 'synthetic-driver', data: () => data}}]}); },
    get unsubscribed() { return unsubscribed; }, get disconnected() { return disconnected; },
  };
}
const point = extra => ({driverId: 'synthetic-driver', name: 'Synthetic', lat: 14.5, lng: 121, status: 'online', ...extra});
const results = [];
function check(id, description, run) {
  try { run(fixture()); results.push({id, description, passed: true}); }
  catch (error) { results.push({id, description, passed: false, reason: error.message.split('\n')[0]}); }
}
check('L01', 'Valid live fix updates the marker', f => {
  f.move(point()); assert.equal(f.markers['synthetic-driver'].lat, 14.5);
});
check('L02', 'Missing payload creates no marker', f => {
  f.move(null); assert.equal(f.meta.size, 0);
});
check('L03', 'Malformed or out-of-range fix cannot reach the marker layer', f => {
  for (const lat of [NaN, Infinity, 91, '14.5']) f.move(point({lat}));
  assert.equal(f.meta.size, 0);
});
check('L04', 'Older socket fix cannot replace a newer fix', f => {
  f.move(point({lat: 14.6, timestamp: now})); f.move(point({lat: 14.4, timestamp: now - 60000}));
  assert.equal(f.meta.get('synthetic-driver').lat, 14.6);
});
check('L05', 'Old Firestore snapshot retains its actual location age', f => {
  f.subscribe(); f.firestore(point({updatedAt: {toMillis: () => now - 600000}}));
  assert.equal(f.meta.get('synthetic-driver').lastSeen, now - 600000);
});
check('L06', 'Older Firestore fix cannot rewind a newer socket fix', f => {
  f.subscribe(); f.move(point({lat: 14.6, timestamp: now}));
  f.firestore(point({lat: 14.4, updatedAt: {toMillis: () => now - 60000}}));
  assert.equal(f.meta.get('synthetic-driver').lat, 14.6);
});
check('L07', 'Completion removes the current marker', f => {
  f.move(point()); f.status(point({status: 'completed'})); assert.equal(f.meta.size, 0);
  assert.equal(f.markers['synthetic-driver'], undefined);
});
check('L08', 'Older fix cannot recreate a completed trip marker', f => {
  f.move(point({timestamp: now - 1000})); f.status(point({status: 'completed', timestamp: now}));
  f.move(point({timestamp: now - 500})); assert.equal(f.meta.size, 0);
});
check('L15', 'Later online status cannot recreate a completed trip marker', f => {
  f.move(point({timestamp: now - 1000})); f.status(point({status: 'completed', timestamp: now}));
  f.status(point({timestamp: now + 1})); assert.equal(f.meta.size, 0);
  assert.equal(f.markers['synthetic-driver'], undefined);
});
check('L09', 'Online without a real fix must not create a fallback position', f => {
  f.status({driverId: 'synthetic-driver', status: 'online'}); assert.equal(f.meta.size, 0);
});
check('L10', 'Offline retains the last known real position', f => {
  f.move(point()); f.status({driverId: 'synthetic-driver', status: 'offline'});
  assert.equal(f.meta.get('synthetic-driver').lat, 14.5);
  assert.equal(f.markers['synthetic-driver'].status, 'offline');
});
check('L11', 'Movement retains an existing returning-to-base state', f => {
  f.move(point({status: 'returning_to_base'})); f.move(point());
  assert.equal(f.meta.get('synthetic-driver').status, 'returning_to_base');
});
check('L12', 'Panel subscribes to the backend lifecycle event', f => {
  f.context._wireDriverSocket(); assert.ok(f.events.get('vendor_status_update')?.size);
});
check('L13', 'Panel cleanup preserves other shared-socket subscribers', f => {
  const dashboardListener = () => {}; f.socket.on('update_admin_map', dashboardListener);
  f.context._wireDriverSocket(); f.context.destroyTrackingPanel();
  assert.ok(f.events.get('update_admin_map')?.has(dashboardListener)); assert.equal(f.disconnected, false);
});
check('L14', 'Panel cleanup unsubscribes its Firestore listener', f => {
  f.subscribe(); f.context.destroyTrackingPanel(); assert.equal(f.unsubscribed, 1);
});
console.log(JSON.stringify({scope: 'Synthetic current web handler review; no phone or production writes',
  total: results.length, passed: results.filter(r => r.passed).length,
  failed: results.filter(r => !r.passed).length, results}, null, 2));
process.exitCode = results.some(result => !result.passed) ? 1 : 0;
