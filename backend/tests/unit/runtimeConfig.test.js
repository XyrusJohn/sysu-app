const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const path = require.resolve('../../src/server.js');
const source = fs.readFileSync(path, 'utf8');
// Execute the server's actual startup configuration, without opening ports/Firebase.
const startup = source.slice(source.indexOf('dotenv.config();'), source.indexOf('initializeFirebase();'));
function load(overrides = {}) {
  return JSON.parse(vm.runInNewContext(startup + `
    JSON.stringify({port, trustProxy: typeof runtimeConfig === 'undefined' ? parseInt(process.env.TRUST_PROXY, 10) : runtimeConfig.trustProxy,
      origins: typeof runtimeConfig === 'undefined' ? null : runtimeConfig.allowedOrigins,
      globalLimit: typeof runtimeConfig === 'undefined' ? null : runtimeConfig.globalLimit})`,
  {process: {env: {PORT: '8080', TRUST_PROXY: '0', NODE_ENV: 'development', ALLOWED_ORIGINS: 'http://localhost:5173', ...overrides}},
    dotenv: {config() {}}, console: {error() {}}, require: createRequire(path)}));
}
test('R19 malformed ports fail startup instead of silently changing the destination', () => {
  for (const PORT of ['abc', '8080x', '-1', '1.5']) assert.throws(() => load({PORT}), /PORT/i);
});
test('R19 ports must be in the valid TCP range', () => {
  for (const PORT of ['0', '65536', '99999999999999999']) assert.throws(() => load({PORT}), /PORT/i);
  assert.equal(load({PORT: '3030'}).port, 3030);
});
test('R19 explicit trusted proxy addresses retain their IP/CIDR semantics', () => {
  assert.equal(load({TRUST_PROXY: '10.0.0.1'}).trustProxy, '10.0.0.1');
  assert.equal(load({TRUST_PROXY: '10.0.0.0/24'}).trustProxy, '10.0.0.0/24');
  assert.equal(load({TRUST_PROXY: '1'}).trustProxy, 1);
});
test('R19 invalid proxy settings fail rather than changing security semantics', () => {
  for (const TRUST_PROXY of ['true', '999.1.1.1', '10.0.0.1/99', '-1']) assert.throws(() => load({TRUST_PROXY}), /TRUST_PROXY/i);
});
test('R20 explicit origins and rate overrides are consumed by startup config', () => {
  const config = load({ALLOWED_ORIGINS: 'https://staging.example.invalid', RATE_LIMIT_MAX: '1234'});
  assert.deepEqual(config.origins, ['https://staging.example.invalid']);
  assert.equal(config.globalLimit, 1234);
});
test('R20 production cannot accidentally allow local development origins', () => {
  assert.throws(() => load({NODE_ENV: 'production', ALLOWED_ORIGINS: 'http://localhost:5173'}), /origin/i);
});
test('R20 origins are exact origins and limits are bounded positive integers', () => {
  assert.throws(() => load({ALLOWED_ORIGINS: 'https://example.invalid/private'}), /origin/i);
  for (const RATE_LIMIT_MAX of ['0', '-1', 'foo', '1.5']) assert.throws(() => load({RATE_LIMIT_MAX}), /RATE_LIMIT_MAX/i);
});
