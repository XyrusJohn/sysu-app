import {before, after, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
let db;
before(() => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8085');
  admin.initializeApp({projectId: 'demo-sysu-security'});
  db = admin.firestore();
  const path = require.resolve('../../src/config/firebase');
  require.cache[path] = {id:path, filename:path, loaded:true, exports:{admin}};
});
after(async () => {await db?.terminate(); await admin.app().delete();});
beforeEach(async () => {
  await db.recursiveDelete(db.collection('queue'));
  await db.recursiveDelete(db.collection('qr_tokens'));
  for (const token of ['token-a','token-b']) {
    await db.collection('qr_tokens').doc(token).set({used:false, isUsed:false,
      expiresAt:admin.firestore.Timestamp.fromMillis(Date.now()+60000)});
  }
});
function scan(token, uid='driver-a') {
  const ctrl = require('../../src/controllers/qrController');
  return new Promise((resolve,reject) => {
    const res = {statusCode:200, status(code) {this.statusCode=code; return this;}, json(body) {resolve({status:this.statusCode,body});}};
    ctrl.scanToken({user:{uid}, userData:{role:'driver', status:'active'},
      body:{token,driverId:uid,truckType:'truck',plateNumber:'TEST'}},res,reject);
  });
}
test('R11: different tokens scanned concurrently admit a driver only once', async () => {
  const responses = await Promise.all([scan('token-a'), scan('token-b')]);
  assert.deepEqual(responses.map(r=>r.status).sort(), [200,409]);
  assert.equal((await db.collection('queue').get()).size,1);
  assert.equal((await db.collection('qr_tokens').where('used','==',true).get()).size,1);
});
test('R11: token replay from concurrent drivers admits only one', async () => {
  const responses = await Promise.all([scan('token-a'), scan('token-a','driver-b')]);
  assert.deepEqual(responses.map(r=>r.status).sort(), [200,410]);
  assert.equal((await db.collection('queue').get()).size,1);
});
test('R11: completed queue entry permits a new admission', async () => {
  await db.collection('queue').doc('old').set({driverId:'driver-a',status:'completed'});
  assert.equal((await scan('token-a')).status,200);
});
