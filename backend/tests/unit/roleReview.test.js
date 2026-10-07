const test = require('node:test');
const assert = require('node:assert/strict');
let writes;
const data = {
  'users/admin': { role: 'admin', status: 'active' },
  'users/requester': { role: 'driver', status: 'active' },
  'role_requests/request': { requesterId: 'requester', requestedRole: 'super_admin', status: 'pending' },
};
const ref = (key) => ({ key, get: async () => ({ exists: !!data[key], data: () => data[key] }), update: async (value) => { writes.push([key, value]); } });
const db = { collection: (coll) => ({ doc: (id) => ref(`${coll}/${id}`) }), runTransaction: async (fn) => fn({
  get: (target) => target.get(), update: (target, value) => writes.push([target.key, value]),
}) };
const firestore = () => db;
firestore.FieldValue = { serverTimestamp: () => 'time' };
const configPath = require.resolve('../../src/config/firebase');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { admin: { firestore } } };
const roles = require('../../src/controllers/admin/roleRequestController');
test.beforeEach(() => { writes = []; });
test('R04: ordinary admin cannot approve a super-admin role request', async () => {
  await assert.rejects(roles.approveRoleRequest('request', 'admin'), /super.admin|Forbidden/i);
  assert.equal(writes.length, 0);
});
test('R04: requester cannot review their own role request', async () => {
  await assert.rejects(roles.approveRoleRequest('request', 'requester'), /Forbidden|own request/i);
  assert.equal(writes.length, 0);
});

test('R24: an old role request cannot reactivate an account pending deletion', async () => {
  data['users/requester'] = {role: 'driver', status: 'disabled', deletionState: 'pending', pendingRoleChange: 'driver'};
  data['role_requests/request'].requestedRole = 'driver';
  await assert.rejects(roles.approveRoleRequest('request', 'admin'), /deletion/i);
  assert.equal(writes.length, 0);
});

test('R04: approval cannot apply a role request superseded by a direct role change', async () => {
  data['users/requester'] = {role: 'driver', status: 'active', pendingRoleChange: null};
  data['role_requests/request'].requestedRole = 'admin';
  await assert.rejects(roles.approveRoleRequest('request', 'admin'), /superseded/i);
  assert.equal(writes.length, 0);
});
