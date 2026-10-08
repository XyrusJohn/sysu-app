import {before, after, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
let db, ctrl;
before(() => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8085');
  admin.initializeApp({projectId: 'demo-sysu-security'});
  db = admin.firestore();
  const path = require.resolve('../../src/config/firebase');
  require.cache[path] = {id: path, filename: path, loaded: true, exports: {admin}};
  ctrl = require('../../src/controllers/sapAssignmentController');
});
after(async () => {await db?.terminate(); await admin.app().delete();});
beforeEach(async () => {
  for (const name of ['queue', 'sap_assignments', 'overrideRequests', 'overrideTokens', 'cancelRequests']) await db.recursiveDelete(db.collection(name));
});
function invoke(handler, body, uid = 'admin') {
  return new Promise((resolve, reject) => handler({body, user: {uid}},
    {statusCode: 200, status(code) {this.statusCode = code; return this;},
      json(body) {resolve({status: this.statusCode, body});}}, reject));
}
async function seedCancellation(tripStatus = 'assigned') {
  await db.collection('queue').doc('a-history').set({driverId: 'driver', status: 'completed', assignedShipments: [{dispatchKey: 'past'}]});
  await db.collection('queue').doc('z-active').set({driverId: 'driver', status: 'loading', isAssigned: true,
    assignedShipments: [{dispatchKey: 'dispatch'}], activeShipmentsCount: 1});
  await db.collection('sap_assignments').doc('dispatch').set({driverId: 'driver', queueId: 'z-active', tripStatus, lineItems: [{obdNumber: '0001'}]});
  await db.collection('sap_assignments').doc('dispatch').collection('pod_images').doc('retained').set({synthetic: true});
  await db.collection('cancelRequests').doc('request').set({dispatchKey: 'dispatch', reason: 'Synthetic', requestedBy: 'staff', status: 'pending'});
}
test('R13 concurrent override approvals issue exactly one token', async () => {
  await db.collection('overrideRequests').doc('request').set({dispatchKey: 'dispatch', requestedDriverId: 'driver', reason: 'Synthetic', status: 'pending', requestedBy: 'staff'});
  const results = await Promise.all([1, 2].map(() => invoke(ctrl.decideOverride, {requestId: 'request', decision: 'approved'})));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const tokens = await db.collection('overrideTokens').get();
  assert.equal(tokens.size, 1);
  assert.equal((await db.collection('overrideRequests').doc('request').get()).data().tokenId, tokens.docs[0].id);
});
test('R13 cancelled dispatch can be reassigned without leaking the previous POD', async () => {
  await seedCancellation();
  await invoke(ctrl.decideCancelAssignment, {requestId: 'request', decision: 'approved'});
  await db.collection('queue').doc('new-driver').set({driverId: 'next-driver', status: 'waiting', truckType: 'truck', isAssigned: false, isFull: false, entryTime: admin.firestore.Timestamp.now()});
  const assigned = await invoke(ctrl.assignDriver, {dispatchKey: 'dispatch', requestedDriverId: 'next-driver', truckType: 'truck', overrideTokenId: null,
    lineItems: [{obdNumber: '0001', customerName: 'Synthetic', quantity: 1}]});
  assert.equal(assigned.status, 200);
  assert.equal((await db.collection('sap_assignments').doc('dispatch').get()).data().driverId, 'next-driver');
  assert.equal((await db.collection('sap_assignments').doc('dispatch').collection('pod_images').get()).size, 0);
  const history = db.collection('sap_assignment_history').doc('request');
  assert.equal((await history.get()).data().driverId, 'driver');
  assert.equal((await history.collection('pod_images').get()).size, 1);
});
test('R13 override approval competing with requester revoke has one winner', async () => {
  await db.collection('overrideRequests').doc('request').set({dispatchKey: 'dispatch', requestedDriverId: 'driver', reason: 'Synthetic', status: 'pending', requestedBy: 'staff'});
  const results = await Promise.all([invoke(ctrl.decideOverride, {requestId: 'request', decision: 'approved'}),
    invoke(ctrl.revokeOverride, {requestId: 'request'}, 'staff')]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const request = (await db.collection('overrideRequests').doc('request').get()).data();
  assert.equal((await db.collection('overrideTokens').get()).size, request.status === 'approved' ? 1 : 0);
});
test('R13 cancellation preserves assignment/POD history and selects the exact active queue', async () => {
  await seedCancellation();
  assert.equal((await invoke(ctrl.decideCancelAssignment, {requestId: 'request', decision: 'approved'})).status, 200);
  const assignment = (await db.collection('sap_assignments').doc('dispatch').get()).data();
  assert.equal(assignment?.tripStatus, 'cancelled');
  assert.deepEqual(assignment.lineItems, [{obdNumber: '0001'}]);
  assert.equal((await db.collection('sap_assignments').doc('dispatch').collection('pod_images').get()).size, 1);
  assert.deepEqual((await db.collection('queue').doc('a-history').get()).data().assignedShipments, [{dispatchKey: 'past'}]);
  assert.equal((await db.collection('queue').doc('z-active').get()).data().activeShipmentsCount, 0);
});
test('R13 in-transit/completed assignments cannot be cancelled', async () => {
  for (const state of ['in_transit', 'completed']) {
    await seedCancellation(state);
    assert.equal((await invoke(ctrl.decideCancelAssignment, {requestId: 'request', decision: 'approved'})).status, 409);
    assert.equal((await db.collection('sap_assignments').doc('dispatch').get()).data().tripStatus, state);
    assert.equal((await db.collection('cancelRequests').doc('request').get()).data().status, 'pending');
  }
});
test('R13 competing cancellation decisions have one winner', async () => {
  await seedCancellation();
  const results = await Promise.all(['approved', 'denied'].map(decision => invoke(ctrl.decideCancelAssignment, {requestId: 'request', decision})));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const request = (await db.collection('cancelRequests').doc('request').get()).data();
  assert.equal((await db.collection('sap_assignments').doc('dispatch').get()).data()?.tripStatus,
    request.status === 'approved' ? 'cancelled' : 'assigned');
});
test('R13 request-write failure rolls back cancellation and queue changes', async () => {
  await seedCancellation();
  const original = db.runTransaction.bind(db);
  db.runTransaction = callback => original(async tx => {
    const update = tx.update.bind(tx);
    tx.update = (ref, ...args) => {
      if (ref.path.startsWith('cancelRequests/')) throw new Error('Synthetic decision write failure');
      return update(ref, ...args);
    };
    return callback(tx);
  });
  try {await assert.rejects(invoke(ctrl.decideCancelAssignment, {requestId: 'request', decision: 'approved'}), /Synthetic decision/);}
  finally {db.runTransaction = original;}
  assert.equal((await db.collection('sap_assignments').doc('dispatch').get()).data().tripStatus, 'assigned');
  assert.equal((await db.collection('queue').doc('z-active').get()).data().activeShipmentsCount, 1);
  assert.equal((await db.collection('cancelRequests').doc('request').get()).data().status, 'pending');
});
