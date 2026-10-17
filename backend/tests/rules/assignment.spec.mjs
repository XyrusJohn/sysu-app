import {before, after, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
let db, sapRows;
const sourceRow = (dispatchKey='test-dispatch',quantity='10') => ({SAPDispatchNumber:dispatchKey,OBDNumber:'000001',
  OBDItem:'001',Quantity:quantity,ShipToParty:'0010000001',ShipToPartyName:'Synthetic',Address:'Synthetic destination',
  Latitude:'14.6628',Longitude:'120.9578',Volume:'0.045',Weight:'21.36',TruckType:'4W',Driver:'',Delivery:'',PgiStatus:'X'});
before(() => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8085');
  admin.initializeApp({projectId: 'demo-sysu-security'});
  db = admin.firestore();
  const configPath = require.resolve('../../src/config/firebase');
  require.cache[configPath] = {id:configPath, filename:configPath, loaded:true, exports:{admin}};
  const sapPath=require.resolve('../../src/services/sapSource');
  const {isUnassigned}=require(sapPath);
  require.cache[sapPath]={id:sapPath,filename:sapPath,loaded:true,exports:{read:async()=>({rows:sapRows.filter(isUnassigned),fetchedAt:Date.now()})}};
});
after(async () => { await db?.terminate(); await admin.app().delete(); });
beforeEach(async () => {
  sapRows=['test-dispatch','dispatch-a','dispatch-b'].map(key=>sourceRow(key));
  await db.recursiveDelete(db.collection('sap_assignments'));
  await db.recursiveDelete(db.collection('queue'));
  await db.recursiveDelete(db.collection('overrideTokens'));
  await db.collection('queue').doc('queue-a').set({driverId:'driver-a', truckType:'4W', status:'waiting', isAssigned:false, isFull:false, entryTime:admin.firestore.Timestamp.now()});
});
function invoke(handler, body) {
  return new Promise((resolve,reject) => {
    const res = {statusCode:200, status(code) {this.statusCode=code;return this;}, json(body) {resolve({status:this.statusCode,body});}};
    handler({body, user:{uid:'staff'}},res,reject);
  });
}
const assignment = (quantity) => ({dispatchKey:'test-dispatch',requestedDriverId:'driver-a',truckType:'4W',overrideTokenId:null,driverSnapshot:null,lineItems:[{obdNumber:'000001',quantity,customerName:'Synthetic'}]});
test('R07: exact ordinary frontend request succeeds without override', async () => {
  const ctrl = require('../../src/controllers/sapAssignmentController');
  const result = await invoke(ctrl.assignDriver,assignment(10));
  assert.equal(result.status,200);
  assert.equal((await db.collection('sap_assignments').doc('test-dispatch').get()).data().driverId,'driver-a');
});
test('R15: positive decimal quantity strings are accepted', async () => {
  sapRows[0].Quantity='10.5';
  const ctrl = require('../../src/controllers/sapAssignmentController');
  const result = await invoke(ctrl.assignDriver,assignment('10.5'));
  assert.equal(result.status,200);
  assert.equal((await db.collection('sap_assignments').doc('test-dispatch').get()).data().lineItems[0].quantity,10.5);
});
test('assigned driver receives location identity and physical metrics from SAP',async()=>{
  const ctrl=require('../../src/controllers/sapAssignmentController');
  assert.equal((await invoke(ctrl.assignDriver,assignment(10))).status,200);
  const item=(await db.collection('sap_assignments').doc('test-dispatch').get()).data().lineItems[0];
  assert.equal(item.shipTo,'0010000001');
  assert.equal(item.deliveryAddress,'Synthetic destination');
  assert.equal(item.latitude,14.6628);
  assert.equal(item.longitude,120.9578);
  assert.equal(item.volume,0.045);
  assert.equal(item.weight,21.36);
  assert.equal(Object.hasOwn(item,'amount'),false);
});

for(const [name,patch] of [
  ['unknown dispatch',{dispatchKey:'invented'}],
  ['foreign OBD',{lineItems:[{obdNumber:'FOREIGN',quantity:10,customerName:'Synthetic'}]}],
  ['fabricated quantity',{lineItems:[{obdNumber:'000001',quantity:999,customerName:'Synthetic'}]}],
  ['fabricated customer',{lineItems:[{obdNumber:'000001',quantity:10,customerName:'INVENTED'}]}],
]) {
  test(`R15 ${name} cannot create an assignment or consume an override`,async()=>{
    await seedToken({dispatchKey:patch.dispatchKey || 'test-dispatch'});
    const ctrl=require('../../src/controllers/sapAssignmentController');
    const result=await invoke(ctrl.assignDriver,{...assignment(10),overrideTokenId:'token-a',...patch});
    assert.equal(result.status,409);
    assert.equal((await db.collection('sap_assignments').get()).size,0);
    assert.equal((await db.collection('overrideTokens').doc('token-a').get()).data().consumedAt,null);
    assert.equal((await db.collection('queue').doc('queue-a').get()).data().status,'waiting');
  });
}
test('R15 source-assigned dispatch no longer qualifies despite a stale browser list',async()=>{
  sapRows[0].Driver='Assigned Driver';
  const ctrl=require('../../src/controllers/sapAssignmentController');
  assert.equal((await invoke(ctrl.assignDriver,assignment(10))).status,409);
  assert.equal((await db.collection('sap_assignments').get()).size,0);
});
test('SAP grouping preserves distinct OBD rows and repeated OBD item multiplicity in one dispatch',async()=>{
  sapRows=[sourceRow(),{...sourceRow(),OBDNumber:'000002',OBDItem:'002',Quantity:'2'},
    {...sourceRow(),OBDItem:'003',Quantity:'3'}];
  const ctrl=require('../../src/controllers/sapAssignmentController');
  const lineItems=sapRows.map(row=>({obdNumber:row.OBDNumber,quantity:row.Quantity,customerName:row.ShipToPartyName}));
  assert.equal((await invoke(ctrl.assignDriver,{...assignment(10),lineItems})).status,200);
  assert.equal((await db.collection('sap_assignments').doc('test-dispatch').get()).data().lineItems.length,3);
});
test('SAP group cannot silently drop an OBD or duplicate a row beyond source multiplicity',async()=>{
  sapRows=[sourceRow(),{...sourceRow(),OBDNumber:'000002'}];
  const ctrl=require('../../src/controllers/sapAssignmentController');
  assert.equal((await invoke(ctrl.assignDriver,assignment(10))).status,409);
  assert.equal((await invoke(ctrl.assignDriver,{...assignment(10),lineItems:[...assignment(10).lineItems,...assignment(10).lineItems]})).status,409);
  assert.equal((await db.collection('sap_assignments').get()).size,0);
});
async function seedToken(patch={}) {
  await db.collection('overrideTokens').doc('token-a').set({dispatchKey:'test-dispatch',requestedDriverId:'driver-a',
    expiresAt:admin.firestore.Timestamp.fromMillis(Date.now()+60000),consumedAt:null,...patch});
}
test('R08: valid override consumes and assigns atomically with a single concurrent winner',async()=>{
  await seedToken();
  const ctrl=require('../../src/controllers/sapAssignmentController');
  const body={...assignment(10),overrideTokenId:'token-a'};
  const results=await Promise.all([invoke(ctrl.assignDriver,body),invoke(ctrl.assignDriver,body)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const token=(await db.collection('overrideTokens').doc('token-a').get()).data();
  assert.ok(token.consumedAt);assert.equal(token.consumedBy,'staff');assert.equal(token.consumedForAssignment,'test-dispatch');
  assert.equal((await db.collection('sap_assignments').get()).size,1);
  assert.equal((await db.collection('queue').doc('queue-a').get()).data().assignedShipments.length,1);
});
for(const [scenario,patch,code] of [
  ['expired',{expiresAt:admin.firestore.Timestamp.fromMillis(1)},'TOKEN_EXPIRED'],
  ['different dispatch',{dispatchKey:'other'},'TOKEN_DISPATCH_MISMATCH'],
  ['different driver',{requestedDriverId:'other'},'TOKEN_DRIVER_MISMATCH'],
  ['already consumed',{consumedAt:admin.firestore.Timestamp.fromMillis(1)},'TOKEN_CONSUMED'],
]) {
  test(`R08: ${scenario} token cannot commit assignment`,async()=>{
    await seedToken(patch);
    const ctrl=require('../../src/controllers/sapAssignmentController');
    const result=await invoke(ctrl.assignDriver,{...assignment(10),overrideTokenId:'token-a'});
    assert.equal(result.status,403);assert.equal(result.body.code,code);
    assert.equal((await db.collection('sap_assignments').get()).size,0);
    if(scenario!=='already consumed') assert.equal((await db.collection('overrideTokens').doc('token-a').get()).data().consumedAt,null);
    assert.equal((await db.collection('queue').doc('queue-a').get()).data().status,'waiting');
  });
}
test('R08: failure after token consumption rolls back token and assignment',async()=>{
  await seedToken();
  const original=db.runTransaction.bind(db);
  db.runTransaction=callback=>original(async tx=>{
    const update=tx.update.bind(tx);
    tx.update=(ref,...args)=>{
      if(ref.path.startsWith('queue/')) throw new Error('Synthetic assignment persistence failure');
      return update(ref,...args);
    };
    return callback(tx);
  });
  try {
    const ctrl=require('../../src/controllers/sapAssignmentController');
    await assert.rejects(invoke(ctrl.assignDriver,{...assignment(10),overrideTokenId:'token-a'}),/Synthetic assignment/);
  } finally {db.runTransaction=original;}
  assert.equal((await db.collection('overrideTokens').doc('token-a').get()).data().consumedAt,null);
  assert.equal((await db.collection('sap_assignments').get()).size,0);
  assert.equal((await db.collection('queue').doc('queue-a').get()).data().status,'waiting');
});

test('R12 concurrent different dispatches lose no shipment list entries', async () => {
  const ctrl = require('../../src/controllers/sapAssignmentController');
  const results = await Promise.all(['dispatch-a', 'dispatch-b'].map(dispatchKey => invoke(ctrl.assignDriver, {...assignment(10), dispatchKey})));
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  const queue = (await db.collection('queue').doc('queue-a').get()).data();
  assert.equal(queue.activeShipmentsCount, 2);
  assert.deepEqual(queue.assignedShipments.map(item => item.dispatchKey).sort(), ['dispatch-a', 'dispatch-b']);
  assert.equal((await db.collection('sap_assignments').get()).size, 2);
});
test('R12 historical completed queue cannot bypass eligibility through an older pre-transit load', async () => {
  await db.collection('queue').doc('queue-a').update({status: 'completed'});
  await db.collection('sap_assignments').doc('older').set({driverId: 'driver-a', tripStatus: 'assigned'});
  const ctrl = require('../../src/controllers/sapAssignmentController');
  assert.equal((await invoke(ctrl.assignDriver, assignment(10))).status, 409);
  assert.equal((await db.collection('sap_assignments').doc('test-dispatch').get()).exists, false);
});
test('R12 completed assignment in the same queue session cannot receive another dispatch', async () => {
  await db.collection('queue').doc('queue-a').update({isAssigned: false, status: 'waiting'});
  await db.collection('sap_assignments').doc('older').set({driverId: 'driver-a', queueId: 'queue-a', tripStatus: 'completed'});
  const ctrl = require('../../src/controllers/sapAssignmentController');
  const result = await invoke(ctrl.assignDriver, assignment(10));
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'DRIVER_SESSION_COMPLETED');
  assert.equal((await db.collection('sap_assignments').doc('test-dispatch').get()).exists, false);
});
test('new QR queue session is eligible after an older completed session', async () => {
  await db.collection('sap_assignments').doc('older').set({driverId: 'driver-a', queueId: 'old-queue', tripStatus: 'completed'});
  const ctrl = require('../../src/controllers/sapAssignmentController');
  const result = await invoke(ctrl.assignDriver, assignment(10));
  assert.equal(result.status, 200);
  assert.equal((await db.collection('sap_assignments').doc('test-dispatch').get()).data().queueId, 'queue-a');
});
test('UID fallback selects the eligible queue rather than an older completed queue', async () => {
  await db.collection('queue').doc('aaa-old').set({driverId: 'driver-a', truckType: '4W', status: 'completed', isAssigned: false});
  await db.collection('sap_assignments').doc('older').set({driverId: 'driver-a', queueId: 'aaa-old', tripStatus: 'completed'});
  const ctrl = require('../../src/controllers/sapAssignmentController');
  const result = await invoke(ctrl.assignDriver, assignment(10));
  assert.equal(result.status, 200);
  assert.equal((await db.collection('sap_assignments').doc('test-dispatch').get()).data().queueId, 'queue-a');
});
test('UID fallback rejects two eligible queue sessions rather than choosing one arbitrarily', async () => {
  await db.collection('queue').doc('queue-b').set({driverId: 'driver-a', truckType: '4W', status: 'waiting', isAssigned: false});
  const ctrl = require('../../src/controllers/sapAssignmentController');
  const result = await invoke(ctrl.assignDriver, assignment(10));
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'DRIVER_SESSION_AMBIGUOUS');
  assert.equal((await db.collection('sap_assignments').doc('test-dispatch').get()).exists, false);
});
for (const status of ['assigned', 'loading', 'loaded', 'fully_loaded']) {
  test(`same-session ${status} driver can receive another dispatch before transit`, async () => {
    await db.collection('queue').doc('queue-a').update({isAssigned: true, status: 'loading'});
    await db.collection('sap_assignments').doc('older').set({driverId: 'driver-a', queueId: 'queue-a', tripStatus: status});
    const ctrl = require('../../src/controllers/sapAssignmentController');
    assert.equal((await invoke(ctrl.assignDriver, assignment(10))).status, 200);
  });
}
for (const status of ['in_transit', 'returning_to_base']) {
  test(`${status} driver cannot receive another dispatch`, async () => {
    await db.collection('queue').doc('queue-a').update({isAssigned: true, status: 'loading'});
    await db.collection('sap_assignments').doc('older').set({driverId: 'driver-a', queueId: 'queue-a', tripStatus: status});
    const ctrl = require('../../src/controllers/sapAssignmentController');
    const result = await invoke(ctrl.assignDriver, assignment(10));
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'DRIVER_ON_ACTIVE_LOAD');
    assert.equal((await db.collection('sap_assignments').doc('test-dispatch').get()).exists, false);
  });
}
test('R15 pre-transit fast path cannot assign a mismatched truck type', async () => {
  await db.collection('sap_assignments').doc('older').set({driverId: 'driver-a', tripStatus: 'assigned'});
  const ctrl = require('../../src/controllers/sapAssignmentController');
  assert.equal((await invoke(ctrl.assignDriver, {...assignment(10), truckType: 'different-truck'})).status, 409);
  assert.equal((await db.collection('sap_assignments').doc('test-dispatch').get()).exists, false);
});
test('R15 client snapshot cannot overwrite authoritative driver identity', async () => {
  await db.collection('queue').doc('queue-a').update({driverName: 'SERVER NAME', plateNumber: 'SERVER PLATE', truckCompany: 'SERVER COMPANY'});
  const ctrl = require('../../src/controllers/sapAssignmentController');
  assert.equal((await invoke(ctrl.assignDriver, {...assignment(10), driverSnapshot: {driverName: 'SPOOF', truckPlate: 'SPOOF', truckCompany: 'SPOOF'}})).status, 200);
  const stored = (await db.collection('sap_assignments').doc('test-dispatch').get()).data();
  assert.equal(stored.driverName, 'SERVER NAME');
  assert.equal(stored.truckPlate, 'SERVER PLATE');
  assert.equal(stored.truckCompany, 'SERVER COMPANY');
});
