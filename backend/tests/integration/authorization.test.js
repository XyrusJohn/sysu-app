const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const configPath = require.resolve('../../src/config/firebase');
const profiles = {
  driver: { role: 'driver', status: 'active' }, pending: { role: 'pending', status: 'inactive' },
  inactive: { role: 'fleet_manager', status: 'inactive' }, staff: { role: 'fleet_manager', status: 'active' },
};
const fakeDb = { collection: (name) => ({ doc: (uid) => ({ get: async () => ({
  exists: Boolean(profiles[uid]), data: () => name === 'users' ? profiles[uid] : { driverName: 'Synthetic', privateNote: 'private' },
}) }) }) };
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { admin: {
  auth: () => ({ verifyIdToken: async (token) => ({ uid: token }) }), firestore: () => fakeDb,
} } };
// Isolate business handlers: this test proves the real route/middleware boundary,
// independent of unrelated assignment and SAP I/O failures.
const ctrlPath = require.resolve('../../src/controllers/sapAssignmentController');
const handler = (req, res) => res.json({ reachedBusinessHandler: true });
require.cache[ctrlPath] = { id: ctrlPath, filename: ctrlPath, loaded: true, exports: Object.fromEntries([
  'peekEarliest','assignDriver','requestOverride','decideOverride','revokeOverride',
  'requestCancelAssignment','decideCancelAssignment','revokeCancelAssignment','getActiveDriverLocations',
].map(name => [name, handler])) };
const app = express();
app.use(express.json());
app.use('/api/sap', require('../../src/routes/sapAssignmentRoute'));
app.use('/api/drivers', require('../../src/routes/driverRoute'));
let server, url;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); });
for (const actor of ['driver', 'pending', 'inactive']) {
  test(`R09: ${actor} cannot access dispatch operations`, async () => {
    for (const [method, route] of [['GET','peek'], ['POST','assign'], ['GET','locations'], ['POST','overrides/request'], ['POST','cancel/request']]) {
      const response = await fetch(`${url}/api/sap/${route}`, { method, headers: { Authorization: `Bearer ${actor}` } });
      assert.equal(response.status, 403, `${actor}: ${method} ${route}`);
    }
  });
}
test('R09: active staff can access the dispatch boundary', async () => {
  const response = await fetch(`${url}/api/sap/peek`, { headers: { Authorization: 'Bearer staff' } });
  assert.equal(response.status, 200);
});
test('R02: driver document endpoint requires authentication', async () => {
  const response = await fetch(`${url}/api/drivers/driver`);
  assert.equal(response.status, 401);
});
