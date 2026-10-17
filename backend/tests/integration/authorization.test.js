const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const configPath = require.resolve('../../src/config/firebase');
const profiles = {
  driver: { role: 'driver', status: 'active' }, pending: { role: 'pending', status: 'inactive' },
  inactive: { role: 'fleet_manager', status: 'inactive' }, staff: { role: 'fleet_manager', status: 'active' },
  admin: { role: 'admin', status: 'active' }, superadmin: { role: 'super_admin', status: 'active' },
};
let capacityWrites = 0;
const fakeDb = {runTransaction: async callback => callback({get: async ref => ref.collectionName === 'qr_tokens'
  ? {exists:true,data:()=>({used:false,expiresAt:{toMillis:()=>Date.now()+60000}})} : {empty:true,exists:false},set(){},update(){}}),
  batch: () => ({update() {}, commit: async () => {}}), collection: (name) => ({ where: () => ({where: () => ({limit: () => ({}),get: async () => ({empty: true, forEach() {}})})}), doc: (uid) => ({collectionName:name,id:uid || 'generated',update: async () => {capacityWrites++;}, get: async () => ({
  exists: Boolean(profiles[uid]), data: () => name === 'users' ? profiles[uid] : { driverName: 'Synthetic', privateNote: 'private' },
}) }) }) };
const firestore = () => fakeDb;
firestore.FieldValue = {serverTimestamp: () => 'time'};
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { admin: {
  auth: () => ({ verifyIdToken: async (token, checkRevoked) => {
    if(token === 'revoked' && checkRevoked) throw new Error('Token revoked');
    return {uid:token === 'revoked' ? 'staff' : token};
  } }), firestore,
} } };
// Isolate business handlers: this test proves the real route/middleware boundary,
// independent of unrelated assignment and SAP I/O failures.
const ctrlPath = require.resolve('../../src/controllers/sapAssignmentController');
const handler = (req, res) => res.json({ reachedBusinessHandler: true });
require.cache[ctrlPath] = { id: ctrlPath, filename: ctrlPath, loaded: true, exports: Object.fromEntries([
  'peekEarliest','assignDriver','requestOverride','decideOverride','revokeOverride',
  'requestCancelAssignment','decideCancelAssignment','revokeCancelAssignment','getActiveDriverLocations',
].map(name => [name, handler])) };
const sapControllerPath = require.resolve('../../src/controller/sapController');
require.cache[sapControllerPath] = {id:sapControllerPath,filename:sapControllerPath,loaded:true,exports:{getSapData:handler,getAssignedDispatchDetails:handler}};
const app = express();
app.use(express.json());
app.use('/api/sap', require('../../src/routes/sapAssignmentRoute'));
app.use('/api/sap', require('../../src/routes/sapRoute'));
app.use('/api/drivers', require('../../src/routes/driverRoute'));
app.use('/api/qr', require('../../src/routes/qrRoute'));
const deletionReached = [];
const guardControllerPath = require.resolve('../../src/controllers/admin/guardController');
const truckCompanyControllerPath = require.resolve('../../src/controllers/admin/truckCompanyController');
const deleteHandler = kind => (req, res) => { deletionReached.push(kind); res.json({reachedBusinessHandler:true}); };
require.cache[guardControllerPath] = {id:guardControllerPath,filename:guardControllerPath,loaded:true,exports:{
  createGuard: deleteHandler('createGuard'), updateGuard: deleteHandler('updateGuard'), setGuardActive: deleteHandler('setGuardActive'), deleteGuard: deleteHandler('guard'),
}};
require.cache[truckCompanyControllerPath] = {id:truckCompanyControllerPath,filename:truckCompanyControllerPath,loaded:true,exports:{
  createTruckCompany: deleteHandler('createTruckCompany'), updateTruckCompany: deleteHandler('updateTruckCompany'), setTruckCompanyActive: deleteHandler('setTruckCompanyActive'), deleteTruckCompany: deleteHandler('truckCompany'),
}};
app.use('/api/admin', require('../../src/routes/adminRoute'));
let server, url;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); });
for (const actor of ['driver', 'pending', 'inactive']) {
  test(`R09: ${actor} cannot access dispatch operations`, async () => {
    for (const [method, route, body] of [['GET','peek'], ['POST','assign'], ['GET','locations'], ['POST','overrides/request'], ['POST','cancel/request'], ['GET','shipments'], ['POST','dispatch-details',JSON.stringify({dispatchKeys:['dispatch-a']})]]) {
      const response = await fetch(`${url}/api/sap/${route}`, { method, headers: { Authorization: `Bearer ${actor}`, ...(body ? {'Content-Type':'application/json'} : {}) }, body });
      assert.equal(response.status, 403, `${actor}: ${method} ${route}`);
    }
  });
}
test('R09: active staff can access the dispatch boundary', async () => {
  const response = await fetch(`${url}/api/sap/peek`, { headers: { Authorization: 'Bearer staff' } });
  assert.equal(response.status, 200);
  const details = await fetch(`${url}/api/sap/dispatch-details`, {method:'POST',headers:{Authorization:'Bearer staff','Content-Type':'application/json'},body:JSON.stringify({dispatchKeys:['dispatch-a']})});
  assert.equal(details.status,200);
});
test('R02: driver document endpoint requires authentication', async () => {
  const response = await fetch(`${url}/api/drivers/driver`);
  assert.equal(response.status, 401);
});
test('R02: own driver response excludes unapproved fields', async () => {
  const response = await fetch(`${url}/api/drivers/driver`, {headers:{Authorization:'Bearer driver'}});
  assert.equal(response.status,200);
  assert.equal((await response.json()).data.privateNote,undefined);
});
test('R02: driver cannot read another driver document', async () => {
  const response = await fetch(`${url}/api/drivers/staff`, {headers:{Authorization:'Bearer driver'}});
  assert.equal(response.status,403);
});

test('R10: driver cannot change another driver capacity', async () => {
  capacityWrites = 0;
  const response = await fetch(`${url}/api/drivers/staff/full`, {
    method: 'PATCH', headers: {Authorization: 'Bearer driver', 'Content-Type': 'application/json'},
    body: JSON.stringify({isFull: true}),
  });
  assert.equal(response.status, 403);
  assert.equal(capacityWrites, 0);
});

test('R12: only admin and super_admin can reach master-record deletion routes',async()=>{
  deletionReached.length=0;
  for (const role of ['driver','pending','inactive','staff']) {
    for (const path of ['/api/admin/guards/SG-001','/api/admin/truck-companies/01']) {
      const response=await fetch(`${url}${path}`,{method:'DELETE',headers:{Authorization:`Bearer ${role}`}});
      assert.equal(response.status,403,`${role} ${path}`);
    }
  }
  assert.equal(deletionReached.length,0);
  for (const role of ['admin','superadmin']) {
    for (const path of ['/api/admin/guards/SG-001','/api/admin/truck-companies/01']) {
      const response=await fetch(`${url}${path}`,{method:'DELETE',headers:{Authorization:`Bearer ${role}`}});
      assert.equal(response.status,200,`${role} ${path}`);
    }
  }
  assert.deepEqual(deletionReached,['guard','truckCompany','guard','truckCompany']);
});
test('R11 regression: active driver HTTP scan receives its authorized profile',async()=>{
  const response=await fetch(`${url}/api/qr/scan`,{method:'POST',headers:{Authorization:'Bearer driver','Content-Type':'application/json'},
    body:JSON.stringify({token:'synthetic',driverId:'driver',truckType:'truck',plateNumber:'TEST'})});
  assert.equal(response.status,200);
});
test('R22: revoked HTTP token is rejected even when profile remains active',async()=>{
  const response=await fetch(`${url}/api/drivers/staff`,{headers:{Authorization:'Bearer revoked'}});
  assert.equal(response.status,401);
});
