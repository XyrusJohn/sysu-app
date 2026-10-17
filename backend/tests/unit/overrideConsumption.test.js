const test = require('node:test');
const assert = require('node:assert/strict');
const configPath = require.resolve('../../src/config/firebase');
const firestore = () => { throw new Error('Unexpected real database access'); };
firestore.FieldValue = { serverTimestamp: () => 'server-time' };
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { admin: { firestore } } };
const service = require('../../src/services/tokenService');
const valid = { dispatchKey: 'dispatch', requestedDriverId: 'driver', expiresAt: { toMillis: () => Date.now() + 60000 }, consumedAt: null };

test('R08: await token snapshot and consume a valid token', async () => {
  const writes = [];
  const tx = { get: async () => ({ exists: true, data: () => valid }), update: (...args) => writes.push(args) };
  const result = await service.consumeInTransaction(tx, 'ref', { consumedBy: 'staff', consumedForAssignment: 'dispatch', requestedDriverId: 'driver' });
  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
});
test('R08: reject token bound to another dispatch without writing', async () => {
  const tx = { get: async () => ({ exists: true, data: () => valid }), update: () => assert.fail('must not consume mismatched token') };
  const result = await service.consumeInTransaction(tx, 'ref', { consumedBy: 'staff', consumedForAssignment: 'other', requestedDriverId: 'driver' });
  assert.equal(result.code, 'TOKEN_DISPATCH_MISMATCH');
});
