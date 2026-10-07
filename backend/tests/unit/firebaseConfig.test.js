const test = require('node:test');
const assert = require('node:assert/strict');
let initialized;
const fakeAdmin = {apps:[], credential:{cert: () => 'cert', applicationDefault: () => 'adc'},
  initializeApp(options) {initialized=options; return options;}};
for (const [name, exports] of [['firebase-admin',fakeAdmin], ['dotenv',{config(){}}]]) {
  const path=require.resolve(name);
  require.cache[path]={id:path,filename:path,loaded:true,exports};
}
const {initializeFirebase}=require('../../src/config/firebase');
const keys=['FIREBASE_PROJECT_ID','FIREBASE_SERVICE_ACCOUNT_JSON','FIRESTORE_EMULATOR_HOST','NODE_ENV'];
let saved;
test.beforeEach(() => {saved=Object.fromEntries(keys.map(k=>[k,process.env[k]])); keys.forEach(k=>delete process.env[k]); initialized=undefined;});
test.afterEach(() => {for (const key of keys) {if(saved[key]===undefined) delete process.env[key]; else process.env[key]=saved[key];}});
test('R32: missing project fails instead of defaulting to production', () => {
  assert.throws(initializeFirebase, /FIREBASE_PROJECT_ID/);
  assert.equal(initialized,undefined);
});
test('R18/R32: production rejects accidental emulator configuration', () => {
  Object.assign(process.env,{NODE_ENV:'production',FIREBASE_PROJECT_ID:'test-staging',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8085'});
  assert.throws(initializeFirebase,/emulator/i);
  assert.equal(initialized,undefined);
});
test('R18/R27: malformed credentials fail without exposing their prefix', () => {
  process.env.FIREBASE_PROJECT_ID='test-staging';
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON='SECRET-PREFIX-invalid-json';
  const logs=[];
  const prior=console.error;
  console.error=(...args)=>logs.push(args.join(' '));
  try {assert.throws(initializeFirebase,/credential|JSON/i);} finally {console.error=prior;}
  assert.equal(logs.join('\n').includes('SECRET-PREFIX'),false);
  assert.equal(initialized,undefined);
});
test('R32: explicit demo emulator initializes without production credentials', () => {
  Object.assign(process.env,{FIREBASE_PROJECT_ID:'demo-sysu-security',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8085'});
  initializeFirebase();
  assert.equal(initialized.projectId,'demo-sysu-security');
  assert.equal(initialized.credential,undefined);
});
