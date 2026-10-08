const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const {createRequire} = require('node:module');
const serverPath = require.resolve('../../src/server');
const actualRequire = createRequire(serverPath);
let probe = async () => ({}), app;
const fakeFirebase = {initializeFirebase() {}, admin: {firestore: () => ({doc: () => ({get: () => probe()})})}};
const firebasePath = actualRequire.resolve('./config/firebase');
require.cache[firebasePath] = {id: firebasePath, filename: firebasePath, loaded: true, exports: fakeFirebase};
const fakeIo = {of: () => ({on() {}}), use() {}, on() {}};
function boot() {
  const source = fs.readFileSync(serverPath, 'utf8');
  vm.runInNewContext(source, {require(name) {
    if (name === './config/firebase') return fakeFirebase;
    if (name === 'socket.io') return {Server: class {constructor() {return fakeIo;}}};
    if (name === 'http') return {createServer(value) {app = value; return {listen() {}};}};
    if (name === 'dotenv') return {config() {}};
    if (name.startsWith('./routes/') && !name.includes('healthRoute')) return express.Router();
    if (name.startsWith('./utils/')) return {startCleanupScheduler() {}};
    return actualRequire(name);
  }, process: {env: {NODE_ENV: 'test', PORT: '8080', ALLOWED_ORIGINS: 'http://localhost:5173',
    RELEASE_VERSION: 'synthetic-release', READINESS_TIMEOUT_MS: '100'}}, global: {}, console,
    setTimeout, clearTimeout});
}
async function request(path) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    const body = await response.text();
    return {status: response.status, body: response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(body) : {message: body}, cache: response.headers.get('cache-control')};}
  finally {await new Promise(resolve => server.close(resolve));}
}
test.before(() => boot());
test('R18 liveness exposes release version without a dependency request', async () => {
  let calls = 0; probe = async () => {calls++; return {};};
  const response = await request('/health/live');
  assert.equal(response.status, 200);
  assert.equal(response.body.version, 'synthetic-release');
  assert.equal(response.cache, 'no-store');
  assert.equal(calls, 0);
});
test('R18 readiness fails safely on dependency failure and recovers', async () => {
  probe = async () => {throw new Error('SYNTHETIC-PRIVATE-CREDENTIAL');};
  const failure = await request('/health/ready');
  assert.equal(failure.status, 503);
  assert.equal(JSON.stringify(failure.body).includes('SYNTHETIC-PRIVATE-CREDENTIAL'), false);
  probe = async () => ({});
  assert.equal((await request('/health/ready')).status, 200);
});
test('R18 hung probes time out and overlapping readiness checks coalesce', async () => {
  let finish, calls = 0;
  probe = () => {calls++; return new Promise(resolve => {finish = resolve;});};
  const results = await Promise.all([request('/health/ready'), request('/health/ready')]);
  assert.deepEqual(results.map(result => result.status), [503, 503]);
  assert.equal(calls, 1);
  finish({});
  await new Promise(resolve => setImmediate(resolve));
  probe = async () => ({});
  assert.equal((await request('/health/ready')).status, 200);
});
