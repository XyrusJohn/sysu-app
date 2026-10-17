import {before, after, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const admin=require('firebase-admin');
let db;
before(() => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8085');
  admin.initializeApp({projectId:'demo-sysu-security'});
  db=admin.firestore();
  const path=require.resolve('../../src/config/firebase');
  require.cache[path]={id:path,filename:path,loaded:true,exports:{admin}};
});
after(async () => {await db?.terminate(); await admin.app().delete();});
beforeEach(async () => {for(const name of ['security_guard','truck_company','id_sequences']) await db.recursiveDelete(db.collection(name));});
function invoke(handler,body,params={}) {
  return new Promise((resolve,reject) => {
    const res={status(code){this.statusCode=code;return this;},json(body){resolve({status:this.statusCode,body});}};
        handler({body,params},res,reject);
  });
}
for(const [collection, controller, method, makeBody, seedId] of [
  ['security_guard','guardController','createGuard',n=>({firstName:`Guard ${n}`,lastName:'Synthetic'}),'SG-009'],
  ['truck_company','truckCompanyController','createTruckCompany',n=>({forwarderCode:`TEST-${n}`,name:`Company ${n}`}), '09'],
]) {
  test(`R51: concurrent ${collection} creates preserve every successful record`,async () => {
    await db.collection(collection).doc(seedId).set({legacy:true});
    const handler=require(`../../src/controllers/admin/${controller}`)[method];
    const results=await Promise.all(Array.from({length:6},(_,n)=>invoke(handler,makeBody(n))));
    assert.equal(results.every(r=>r.status===201),true);
    assert.equal(new Set(results.map(r=>r.body.id)).size,6);
    assert.equal((await db.collection(collection).get()).size,7);
    for(const result of results) {
      assert.deepEqual((await db.collection(collection).doc(result.body.id).get()).data(),Object.fromEntries(Object.entries(result.body).filter(([key])=>key!=='id')));
    }
  });
}
test('R48: guard full name collapses repeated whitespace',async () => {
  const ctrl=require('../../src/controllers/admin/guardController');
  const result=await invoke(ctrl.createGuard,{firstName:'  Ana   Maria  ',lastName:'  Dela\tCruz  ',middleInitial:'  B  '});
  assert.equal(result.body.fullName,'Ana Maria B Dela Cruz');
});
test('R51: an imported ID collision is skipped without overwriting it',async () => {
  const ctrl=require('../../src/controllers/admin/truckCompanyController');
  await invoke(ctrl.createTruckCompany,{forwarderCode:'TEST-A',name:'First'});
  await db.collection('truck_company').doc('02').set({legacy:true});
  const result=await invoke(ctrl.createTruckCompany,{forwarderCode:'TEST-B',name:'Next'});
  assert.equal(result.body.id,'03');
  assert.deepEqual((await db.collection('truck_company').doc('02').get()).data(),{legacy:true});
  assert.equal((await db.collection('id_sequences').doc('truck_company').get()).data().maximum,3);
});

test('admin delete removes a guard without reusing its sequential ID',async()=>{
  const controller=require('../../src/controllers/admin/guardController');
  const created=await invoke(controller.createGuard,{firstName:'Synthetic',lastName:'Guard'});
  const removed=await invoke(controller.deleteGuard,{}, {id:created.body.id});
  assert.equal(removed.status,200);
  assert.equal((await db.collection('security_guard').doc(created.body.id).get()).exists,false);
  const next=await invoke(controller.createGuard,{firstName:'Next',lastName:'Guard'});
  assert.notEqual(next.body.id,created.body.id);
});

test('admin delete removes a truck company without reusing its sequential ID',async()=>{
  const controller=require('../../src/controllers/admin/truckCompanyController');
  const created=await invoke(controller.createTruckCompany,{forwarderCode:'TEST-DELETE',name:'Synthetic Company'});
  const removed=await invoke(controller.deleteTruckCompany,{}, {code:created.body.id});
  assert.equal(removed.status,200);
  assert.equal((await db.collection('truck_company').doc(created.body.id).get()).exists,false);
  const next=await invoke(controller.createTruckCompany,{forwarderCode:'TEST-NEXT',name:'Next Company'});
  assert.notEqual(next.body.id,created.body.id);
});
