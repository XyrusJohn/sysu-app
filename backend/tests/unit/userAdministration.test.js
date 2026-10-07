const test = require('node:test');
const assert = require('node:assert/strict');
let records, authFailure, authCalls, events, serial;
const snapshot = key => ({exists: !!records[key], data: () => records[key]});
const ref = key => ({key, id: key.split('/').at(-1), get: async () => snapshot(key),
  update: async data => {records[key] = {...records[key], ...data};},
  delete: async () => {delete records[key];}});
const db = {
  collection(name) { return {doc: id => ref(`${name}/${id || `audit-${++serial}`}`),
    where: (field, op, value) => ({get: async () => ({docs: Object.keys(records)
      .filter(key => key.startsWith(name + '/') && records[key][field] === value)
      .map(key => ({...snapshot(key), id: key.split('/').at(-1)}))})})}; },
  async runTransaction(fn) {
    const pending = [];
    const result = await fn({get: target => target.get(),
      set: (target, data) => pending.push(() => {records[target.key] = data;}),
      update: (target, data) => pending.push(() => {records[target.key] = {...records[target.key], ...data};}),
      delete: target => pending.push(() => {delete records[target.key];})});
    pending.forEach(write => write()); return result;
  },
};
const firestore = () => db;
firestore.FieldValue = {serverTimestamp: () => 'synthetic-time'};
const config = require.resolve('../../src/config/firebase');
require.cache[config] = {id: config, filename: config, loaded: true, exports: {admin: {firestore,
  auth: () => ({deleteUser: async uid => {authCalls.push(uid); if (authFailure) throw authFailure;}})}}};
const users = require('../../src/controllers/userController');
function invoke(handler, actor, body) {
  return new Promise((resolve, reject) => handler({body, user: {uid: actor}, userData: records[`users/${actor}`]},
    {statusCode: 200, status(code) {this.statusCode = code; return this;},
      json(body) {resolve({status: this.statusCode, body});}}, reject));
}
async function status(handler, actor, body) {
  try {return (await invoke(handler, actor, body)).status;} catch (error) {return error.statusCode || 500;}
}
test.beforeEach(() => {
  serial = 0; authCalls = []; events = []; authFailure = null;
  records = {'users/owner': {role: 'super_admin', status: 'active'},
    'users/admin': {role: 'admin', status: 'active'}, 'users/driver': {role: 'driver', status: 'active'},
    'drivers/driver': {driverId: 'driver'}, 'sap_assignments/history': {driverId: 'driver', pod: 'retained'}};
  global._io = {emit: (...args) => events.push(['public', ...args]),
    to: room => ({emit: (...args) => events.push([room, ...args])})};
});
test.after(() => {delete global._io;});

test('R23 ordinary admin cannot demote an existing super admin', async () => {
  assert.equal(await status(users.updateUserRole, 'admin', {uid: 'owner', role: 'driver'}), 403);
  assert.equal(records['users/owner'].role, 'super_admin');
});
test('R23 self role changes cannot remove the last owner', async () => {
  assert.equal(await status(users.updateUserRole, 'owner', {uid: 'owner', role: 'pending'}), 403);
  assert.equal(records['users/owner'].status, 'active');
});
test('R23 transaction rechecks a demoted reviewer instead of trusting stale middleware', async () => {
  const pending = invoke(users.updateUserRole, 'owner', {uid: 'driver', role: 'admin'});
  // Current code reads the stale req.userData only. The transaction must read the profile anew.
  records['users/owner'] = {role: 'driver', status: 'active'};
  const response = await pending.catch(error => ({status: error.statusCode}));
  assert.equal(response.status, 403);
  assert.equal(records['users/driver'].role, 'driver');
});
test('R23 permitted role change records a server audit', async () => {
  assert.equal(await status(users.updateUserRole, 'owner', {uid: 'driver', role: 'admin'}), 200);
  assert.equal(records['users/driver'].role, 'admin');
  assert.ok(Object.keys(records).some(key => key.startsWith('user_admin_audit/')));
});
test('R24 Auth deletion failure returns failure and leaves disabled resumable state', async () => {
  authFailure = Object.assign(new Error('synthetic outage'), {code: 'auth/internal-error'});
  assert.equal(await status(users.deleteUser, 'owner', {uid: 'driver'}), 503);
  assert.equal(records['users/driver'].status, 'disabled');
  assert.equal(records['users/driver'].deletionState, 'pending');
  assert.ok(records['sap_assignments/history']);
  assert.equal(events.some(event => event[0] === 'public'), false);
  authFailure = null;
  assert.equal(await status(users.deleteUser, 'owner', {uid: 'driver'}), 200);
  assert.equal(records['users/driver'].deletionState, 'complete');
});
test('R24 Auth user-not-found completes deletion while keeping a disabled tombstone and history', async () => {
  authFailure = Object.assign(new Error('missing'), {code: 'auth/user-not-found'});
  assert.equal(await status(users.deleteUser, 'owner', {uid: 'driver'}), 200);
  assert.equal(records['users/driver']?.status, 'disabled');
  assert.equal(records['users/driver']?.deletionState, 'complete');
  assert.equal(records['drivers/driver'], undefined);
  assert.ok(records['sap_assignments/history']);
  assert.equal(events.some(event => event[0] === 'public'), false);
});
test('R24 deletion cannot be invoked by a non-super-admin even with stale route context', async () => {
  assert.equal(await status(users.deleteUser, 'admin', {uid: 'driver'}), 403);
  assert.equal(authCalls.length, 0);
});
