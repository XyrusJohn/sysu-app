const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let stored, role, writes, readError;
const firestore = () => ({collection: name => ({doc: id => ({
  get: async () => {
    if (readError) throw readError;
    const value = name === 'users' ? {role, email: 'owner@example.invalid'} : stored;
    return {exists: !!value, id, data: () => value};
  },
  set: async (data, options) => {writes.push({name, id, data, options});},
})})});
const admin = {firestore};
const configPath = require.resolve('../../src/config/firebase');
require.cache[configPath] = {id: configPath, filename: configPath, loaded: true, exports: {admin}};
const warehouse = require('../../src/controllers/admin/warehouseBaseController');
const source = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');

// Execute the shipped handler body, rather than a copied implementation.
function handler(event, nextEvent) {
  const handlers = {}, emitted = [], broadcasts = [];
  const socket = {data: {uid: 'owner'}, on: (name, fn) => {handlers[name] = fn;},
    emit: (...args) => emitted.push(args)};
  const start = source.indexOf(`socket.on("${event}",`);
  const next = source.indexOf(`socket.on("${nextEvent}",`, start);
  assert.ok(start >= 0 && next > start, 'shipped socket handler exists');
  const context = {socket, admin, getWarehouseBaseConfig: warehouse.getWarehouseBaseConfig,
    saveWarehouseBaseConfig: warehouse.saveWarehouseBaseConfig, io: {emit: (...args) => broadcasts.push(args)},
    console: {log() {}, warn() {}, error() {}}};
  vm.runInNewContext(source.slice(start, next), context);
  return {run: handlers[event], emitted, broadcasts};
}

test.beforeEach(() => {stored = undefined; role = 'super_admin'; writes = []; readError = undefined;});

test('warehouse socket reads persisted Firestore settings through exported controller helper', async () => {
  stored = {name: 'Configured warehouse', lat: 14.5, lng: 121.1, radiusMeters: 700};
  const socket = handler('get_warehouse_base', 'save_warehouse_base');
  let result;
  await socket.run(value => {result = value;});
  assert.equal(result.success, true);
  assert.deepEqual(result.data, {id: 'warehouse_base', ...stored});
  assert.equal(writes.length, 0);
});

test('warehouse socket sends default base event when settings do not exist and acknowledgement omitted', async () => {
  const socket = handler('get_warehouse_base', 'save_warehouse_base');
  await socket.run();
  assert.equal(socket.emitted[0]?.[0], 'warehouse_base_data');
  assert.equal(socket.emitted[0][1].name, 'SYSU Main Warehouse');
  assert.equal(writes.length, 0);
});

test('warehouse socket reports Firestore read failure without pretending success', async () => {
  readError = new Error('Synthetic read unavailable');
  const socket = handler('get_warehouse_base', 'save_warehouse_base');
  let result;
  await socket.run(value => {result = value;});
  assert.equal(result.success, false);
  assert.equal(result.message, 'Synthetic read unavailable');
});

test('warehouse save socket persists validated setting for canonical super-admin', async () => {
  const socket = handler('save_warehouse_base', 'get_role_requests');
  let result;
  await socket.run({lat: '14.5', lng: '121.1', radiusMeters: '700', name: 'Configured warehouse'}, value => {result = value;});
  assert.equal(result.success, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'settings');
  assert.equal(writes[0].id, 'warehouse_base');
  assert.equal(writes[0].data.updatedByUid, 'owner');
  assert.equal(writes[0].data.lat, 14.5);
  assert.deepEqual(writes[0].options, {merge: true});
  assert.equal(socket.broadcasts[0][0], 'warehouse_base_updated');
});

test('warehouse save socket still denies ordinary admin without writing', async () => {
  role = 'admin';
  const socket = handler('save_warehouse_base', 'get_role_requests');
  let result;
  await socket.run({lat: 14.5, lng: 121.1, radiusMeters: 700}, value => {result = value;});
  assert.equal(result.success, false);
  assert.match(result.message, /super_admin/);
  assert.equal(writes.length, 0);
});

test('warehouse save socket rejects invalid coordinates without writing', async () => {
  const socket = handler('save_warehouse_base', 'get_role_requests');
  let result;
  await socket.run({lat: 100, lng: 121.1, radiusMeters: 700}, value => {result = value;});
  assert.equal(result.success, false);
  assert.equal(writes.length, 0);
  assert.equal(socket.broadcasts.length, 0);
});

test('all role request functions consumed by production socket server remain callable', () => {
  const roles = require('../../src/controllers/admin/roleRequestController');
  for (const name of ['getRoleRequests', 'createRoleRequest', 'approveRoleRequest', 'rejectRoleRequest']) {
    assert.equal(typeof roles[name], 'function', name);
  }
});
