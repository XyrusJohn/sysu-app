const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
let writes = 0;
let expired = false;
const snapshot = () => ({ exists: true, data: () => ({ used: false, isUsed: false, expiresAt: { toMillis: () => Date.now() + (expired ? -1 : 60000) } }) });
const ref = { id: 'queue', get: async () => snapshot(), update: async () => { writes++; } };
const db = { collection: () => ({ doc: () => ref }), runTransaction: async (fn) => fn({ get: async () => snapshot(), set: () => { writes++; }, update: () => { writes++; } }) };
const firestore = () => db;
firestore.FieldValue = { serverTimestamp: () => 'time' };
const configPath = require.resolve('../../src/config/firebase');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { admin: { firestore } } };
const qr = require('../../src/controllers/qrController');
const { errorHandler } = require('../../src/middleware/errorHandler');
function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } };
    handler(req, res, reject);
  });
}
test.beforeEach(() => { writes = 0; expired = false; });
test('R11: public QR verification never consumes the token', async () => {
  assert.equal((await invoke(qr.verifyToken, { query: { token: 'token' } })).status, 200);
  assert.equal(writes, 0);
});
test('R11: expired QR verification is rejected before cleanup', async () => {
  expired = true;
  assert.equal((await invoke(qr.verifyToken, { query: { token: 'token' } })).status, 410);
});
test('R11: authenticated user cannot scan as another driver', async () => {
  const response = await invoke(qr.scanToken, { user: { uid: 'driver-a' }, userData: {role: 'driver', status: 'active'}, body: { token: 'token', driverId: 'driver-b', truckType: 'truck', plateNumber: 'TEST' } });
  assert.equal(response.status, 403);
  assert.equal(writes, 0);
});

test('R11: pending account cannot admit itself to the driver queue', async () => {
  const response = await invoke(qr.scanToken, { user: {uid: 'pending'}, userData: {role: 'pending', status: 'inactive'},
    body: {token: 'token', driverId: 'pending', truckType: 'truck', plateNumber: 'TEST'} });
  assert.equal(response.status, 403);
  assert.equal(writes, 0);
});
test('R21: validation errors are client errors', async () => {
  const error = z.string().safeParse(1).error;
  const response = await invoke((req, res) => errorHandler(error, req, res), {});
  assert.equal(response.status, 400);
});
test('R21: production server error does not expose internal paths', async () => {
  process.env.NODE_ENV = 'production';
  const response = await invoke((req, res) => errorHandler(new Error('private internal SAP password path'), req, res), {});
  assert.equal(response.body.error, 'Internal Server Error');
});
test('R27: error logs exclude exception secrets and correlate the response',async()=>{
  const logs=[]; const prior=console.error;
  console.error=(...args)=>logs.push(args.join(' '));
  let response;
  try {response=await invoke((req,res)=>errorHandler(new Error('SYNTHETIC-PRIVATE-TOKEN'),req,res),{});}
  finally {console.error=prior;}
  assert.equal(logs.join('\n').includes('SYNTHETIC-PRIVATE-TOKEN'),false);
  assert.match(response.body.requestId,/^[a-f0-9-]{36}$/);
  assert.equal(logs.join('\n').includes(response.body.requestId),true);
});
