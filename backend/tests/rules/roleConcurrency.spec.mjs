import {before, after, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
let db, users, roles;
before(() => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8085');
  admin.initializeApp({projectId: 'demo-sysu-security'});
  db = admin.firestore();
  const path = require.resolve('../../src/config/firebase');
  require.cache[path] = {id: path, filename: path, loaded: true, exports: {admin}};
  users = require('../../src/controllers/userController');
  roles = require('../../src/controllers/admin/roleRequestController');
});
after(async () => {await db?.terminate(); await admin.app().delete();});
beforeEach(async () => {
  for (const name of ['users', 'role_requests', 'user_admin_audit']) await db.recursiveDelete(db.collection(name));
  for (const uid of ['owner-a', 'owner-b']) await db.collection('users').doc(uid).set({role: 'super_admin', status: 'active'});
});
function change(actor, target) {
  return new Promise((resolve, reject) => users.updateUserRole({user: {uid: actor},
    userData: {role: 'super_admin', status: 'active'}, body: {uid: target, role: 'driver'}},
  {json: resolve, status() {return this;}}, reject));
}
test('R23 competing owner demotions preserve one active owner and one audit', async () => {
  const results = await Promise.allSettled([change('owner-a', 'owner-b'), change('owner-b', 'owner-a')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const remaining = (await db.collection('users').get()).docs.filter(doc => doc.data().role === 'super_admin' && doc.data().status === 'active');
  assert.equal(remaining.length, 1);
  assert.equal((await db.collection('user_admin_audit').get()).size, 1);
});
test('R04 competing approval and rejection have one decision and coherent user state', async () => {
  await db.collection('users').doc('driver').set({role: 'driver', status: 'active', pendingRoleChange: 'fleet_manager'});
  await db.collection('role_requests').doc('request').set({requesterId: 'driver', requestedRole: 'fleet_manager', status: 'pending'});
  const results = await Promise.allSettled([roles.approveRoleRequest('request', 'owner-a'), roles.rejectRoleRequest('request', 'owner-b', 'Synthetic review')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const request = (await db.collection('role_requests').doc('request').get()).data();
  const user = (await db.collection('users').doc('driver').get()).data();
  assert.equal(user.pendingRoleChange, null);
  assert.equal(user.role, request.status === 'approved' ? 'fleet_manager' : 'driver');
});
test('R04 crossed owner role requests cannot remove both active owners', async () => {
  for (const uid of ['owner-a', 'owner-b']) {
    await db.collection('users').doc(uid).update({pendingRoleChange: 'driver'});
    await db.collection('role_requests').doc(uid).set({requesterId: uid, requestedRole: 'driver', status: 'pending'});
  }
  const results = await Promise.allSettled([roles.approveRoleRequest('owner-a', 'owner-b'), roles.approveRoleRequest('owner-b', 'owner-a')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await db.collection('users').get()).docs.filter(doc => doc.data().role === 'super_admin').length, 1);
});
test('R04 concurrent requests create one pending request and marker', async () => {
  await db.collection('users').doc('driver').set({role: 'driver', status: 'active'});
  const results = await Promise.allSettled(['admin', 'fleet_manager'].map(requestedRole => roles.createRoleRequest({requesterId: 'driver', requestedRole})));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const requests = await db.collection('role_requests').get();
  assert.equal(requests.size, 1);
  assert.equal((await db.collection('users').doc('driver').get()).data().pendingRoleChange, requests.docs[0].data().requestedRole);
});
