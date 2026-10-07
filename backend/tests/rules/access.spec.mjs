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
  });
});

test('R01: own profile cannot promote role or activate status', async () => {
  await assertFails(updateDoc(doc(own('driver-a'), 'users', 'driver-a'), { role: 'super_admin' }));
  await assertFails(updateDoc(doc(own('pending'), 'users', 'pending'), { status: 'active' }));
  await assertSucceeds(updateDoc(doc(own('driver-a'), 'users', 'driver-a'), { name: 'New name' }));
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
