import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const admin=require('firebase-admin');
const express=require('express');
let db,server,url;
const data={name:'Synthetic Driver',phone:'09000000000',license:'L1',truckType:'4W',plateNumber:'TEST',truckingCompany:'Synthetic',helper:'',notes:''};
before(async()=>{
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8085');
  admin.initializeApp({projectId:'demo-sysu-security'});db=admin.firestore();
  const config=require.resolve('../../src/config/firebase');
  require.cache[config]={id:config,filename:config,loaded:true,exports:{admin:{firestore:admin.firestore,auth:()=>({verifyIdToken:async token=>{if(token==='revoked')throw new Error('Synthetic revoked token');return {uid:token};}})}}};
  const app=express();app.use(express.json({limit:'10kb'}));app.use('/api/drivers',require('../../src/routes/driverRoute'));app.use(require('../../src/middleware/errorHandler').errorHandler);
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));url=`http://127.0.0.1:${server.address().port}/api/drivers/driver-a/profile`;
});
after(async()=>{await new Promise(r=>server.close(r));await db.terminate();await admin.app().delete();});
beforeEach(async()=>{
  for(const collection of ['users','drivers','queue','sap_assignments','driver_profile_audit'])await db.recursiveDelete(db.collection(collection));
  await db.collection('users').doc('staff').set({role:'fleet_manager',status:'active'});
  await db.collection('users').doc('driver-a').set({role:'driver',status:'active'});
  await db.collection('drivers').doc('driver-a').set({driverId:'driver-a',isFull:true});
  for(const [id,driverId,status] of [['a','driver-a','waiting'],['b','driver-b','waiting'],['done','driver-a','completed']])await db.collection('queue').doc(id).set({driverId,status,registrationComplete:false});
});
const request=(token='staff',body=data,method='PUT')=>fetch(url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(method==='PUT'?{body:JSON.stringify(body)}:{})});
test('R14 real staff HTTP save updates only matching active queues and creates audit',async()=>{
  assert.equal((await request()).status,200);
  assert.equal((await db.collection('drivers').doc('driver-a').get()).data().isFull,true);
  assert.equal((await db.collection('queue').doc('a').get()).data().registrationComplete,true);
  for(const id of ['b','done'])assert.equal((await db.collection('queue').doc(id).get()).data().registrationComplete,false);
  assert.equal((await db.collection('driver_profile_audit').get()).size,1);
});
test('R14 actual route denies anonymous driver disabled and revoked sessions',async()=>{
  assert.equal((await request(null)).status,401);assert.equal((await request('revoked')).status,401);
  assert.equal((await request('driver-a')).status,403);
  await db.collection('users').doc('staff').update({status:'disabled'});assert.equal((await request()).status,403);
});
test('R14 strict profile schema rejects privileged fields without writes',async()=>{assert.equal((await request('staff',{...data,isFull:false})).status,400);assert.equal((await db.collection('driver_profile_audit').get()).size,0);});
test('R14 real transaction failure leaves profile and queue unchanged',async()=>{
  const original=db.runTransaction.bind(db);
  db.runTransaction=fn=>original(async tx=>{const update=tx.update.bind(tx);tx.update=(ref,...args)=>{if(ref.path.startsWith('queue/'))throw new Error('Synthetic transaction failure');return update(ref,...args);};return fn(tx);});
  try{assert.equal((await request()).status,500);}finally{db.runTransaction=original;}
  assert.equal((await db.collection('drivers').doc('driver-a').get()).data().name,undefined);
  assert.equal((await db.collection('queue').doc('a').get()).data().registrationComplete,false);
});
test('R14 linked profile deletion is refused and fleet manager cannot delete',async()=>{
  assert.equal((await request('staff',{},'DELETE')).status,403);
  await db.collection('users').doc('staff').update({role:'admin'});
  assert.equal((await request('staff',{},'DELETE')).status,409);
  assert.ok((await db.collection('drivers').doc('driver-a').get()).exists);
});
test('R14 orphan deletion is audited without touching other driver queues',async()=>{
  await db.collection('users').doc('staff').update({role:'admin'});
  await db.collection('users').doc('driver-a').delete();for(const id of ['a','done'])await db.collection('queue').doc(id).delete();
  assert.equal((await request('staff',{},'DELETE')).status,200);assert.equal((await db.collection('drivers').doc('driver-a').get()).exists,false);assert.ok((await db.collection('queue').doc('b').get()).exists);
});
