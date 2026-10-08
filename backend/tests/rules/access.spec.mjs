import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc, getDocs, collection, Timestamp } from 'firebase/firestore';

let env;
const own = (uid) => env.authenticatedContext(uid).firestore();
before(async () => {
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-sysu-security');
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8085');
  env = await initializeTestEnvironment({ projectId: 'demo-sysu-security', firestore: {
    host: '127.0.0.1', port: 8085,
    rules: await readFile(new URL('../../../frontend/firestore.rules', import.meta.url), 'utf8'),
  }});
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const [uid, role] of [['driver-a', 'driver'], ['driver-b', 'driver'], ['staff', 'fleet_manager'], ['admin', 'admin'], ['pending', 'pending']]) {
      await setDoc(doc(db, 'users', uid), { role, status: role === 'pending' ? 'inactive' : 'active', name: uid });
    }
    await setDoc(doc(db, 'queue', 'q-a'), { driverId: 'driver-a', status: 'waiting', entryTime: Timestamp.now(), registrationComplete: false, isFull: false });
    await setDoc(doc(db, 'drivers', 'driver-a'), { driverId: 'driver-a', driverName: 'Synthetic', isFull: false });
    await setDoc(doc(db, 'sap_assignments', 'dispatch-a'), { driverId: 'driver-a', assignedBy: 'staff', tripStatus: 'assigned', lineItems: [] });
    await setDoc(doc(db, 'qr_tokens', 'secret-token'), { used: false });
    await setDoc(doc(db, 'role_requests', 'request-a'), { requesterId: 'driver-a', requestedRole: 'admin', status: 'pending' });
    await setDoc(doc(db, 'sap_assignments', 'dispatch-a', 'pod_images', '000001'), {imageUrl: 'https://example.invalid/synthetic.png'});
    await setDoc(doc(db, 'cancelRequests', 'cancel-a'), {requestedBy: 'staff', dispatchKey: 'dispatch-a', status: 'pending'});
    await setDoc(doc(db, 'sap_assignment_history', 'history-a'), {driverId: 'driver-a', tripStatus: 'cancelled'});
    await setDoc(doc(db, 'sap_assignment_history', 'history-a', 'pod_images', '000001'), {synthetic: true});
  });
});

test('R01: own profile cannot promote role or activate status', async () => {
  await assertFails(updateDoc(doc(own('driver-a'), 'users', 'driver-a'), { role: 'super_admin' }));
  await assertFails(updateDoc(doc(own('pending'), 'users', 'pending'), { status: 'active' }));
  await assertSucceeds(updateDoc(doc(own('driver-a'), 'users', 'driver-a'), { name: 'New name' }));
  await assertSucceeds(updateDoc(doc(own('driver-a'), 'users', 'driver-a'), { photoURL: null }));
});
test('R01: account creation cannot set an initial privileged role', async () => {
  await assertFails(setDoc(doc(own('new-user'), 'users', 'new-user'), { role: 'super_admin', status: 'active', name: 'Attack' }));
  await assertSucceeds(setDoc(doc(own('new-user'), 'users', 'new-user'), { role: 'pending', status: 'inactive', name: 'New user' }));
});
test('R02: anonymous cannot read operational documents or enumerate tokens', async () => {
  const db = env.unauthenticatedContext().firestore();
  for (const [coll, id] of [['queue','q-a'], ['drivers','driver-a'], ['sap_assignments','dispatch-a'], ['qr_tokens','secret-token']]) {
    await assertFails(getDoc(doc(db, coll, id)));
  }
  await assertFails(getDocs(collection(db, 'qr_tokens')));
});
test('R02: staff can read operational data; driver only owns relevant records', async () => {
  await assertSucceeds(getDocs(collection(own('staff'), 'queue')));
  await assertSucceeds(getDoc(doc(own('driver-a'), 'sap_assignments', 'dispatch-a')));
  await assertFails(getDoc(doc(own('driver-b'), 'sap_assignments', 'dispatch-a')));
});
test('R03: owner cannot backdate queue, rewrite assignment identity or fabricate entry', async () => {
  const db = own('driver-a');
  await assertFails(updateDoc(doc(db, 'queue', 'q-a'), { entryTime: Timestamp.fromMillis(1) }));
  await assertFails(updateDoc(doc(db, 'sap_assignments', 'dispatch-a'), { driverId: 'driver-b' }));
  await assertFails(setDoc(doc(db, 'queue', 'fabricated'), { driverId: 'driver-b', status: 'waiting' }));
  await assertSucceeds(updateDoc(doc(db, 'queue', 'q-a'), { registrationComplete: true }));
});
test('R04: clients cannot forge role-request decisions', async () => {
  await assertFails(updateDoc(doc(own('driver-b'), 'role_requests', 'request-a'), { requesterId: 'driver-b', requestedRole: 'super_admin', status: 'approved' }));
  await assertFails(getDocs(collection(own('driver-b'), 'role_requests')));
  await assertSucceeds(getDocs(collection(own('admin'), 'role_requests')));
});

test('R14 staff and owning driver can read POD images; unrelated/pending/anonymous cannot', async () => {
  for (const uid of ['staff', 'admin', 'driver-a']) {
    await assertSucceeds(getDoc(doc(own(uid), 'sap_assignments', 'dispatch-a', 'pod_images', '000001')));
  }
  for (const uid of ['driver-b', 'pending']) {
    await assertFails(getDoc(doc(own(uid), 'sap_assignments', 'dispatch-a', 'pod_images', '000001')));
  }
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'sap_assignments', 'dispatch-a', 'pod_images', '000001')));
});
test('R14 staff cancellation listeners work without exposing requests to drivers', async () => {
  await assertSucceeds(getDocs(collection(own('admin'), 'cancelRequests')));
  await assertSucceeds(getDocs(collection(own('staff'), 'cancelRequests')));
  await assertFails(getDocs(collection(own('driver-b'), 'cancelRequests')));
  await assertFails(updateDoc(doc(own('admin'), 'cancelRequests', 'cancel-a'), {status: 'approved'}));
});
test('R13 direct SDK override writes cannot bypass backend decision transactions', async () => {
  await assertFails(setDoc(doc(own('staff'), 'overrideRequests', 'forged'), {
    dispatchKey: 'dispatch-a', requestedDriverId: 'driver-a', reason: 'Synthetic', requestedBy: 'staff',
    requestedAt: Timestamp.now(), status: 'pending', decidedBy: null, decision: null,
  }));
});
test('R13 archived POD history remains readable only to staff and its original driver', async () => {
  for (const uid of ['staff', 'driver-a']) {
    await assertSucceeds(getDoc(doc(own(uid), 'sap_assignment_history', 'history-a')));
    await assertSucceeds(getDoc(doc(own(uid), 'sap_assignment_history', 'history-a', 'pod_images', '000001')));
  }
  await assertFails(getDoc(doc(own('driver-b'), 'sap_assignment_history', 'history-a', 'pod_images', '000001')));
  await assertFails(updateDoc(doc(own('admin'), 'sap_assignment_history', 'history-a'), {driverId: 'driver-b'}));
});
