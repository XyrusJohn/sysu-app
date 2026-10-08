const test=require('node:test');
const assert=require('node:assert/strict');
let records, failQueue=false;
const snap=key=>({exists:!!records[key],data:()=>records[key]});
const ref=key=>({key,get:async()=>snap(key)});
const db={collection(name){return {doc:id=>ref(`${name}/${id}`),where(field,_op,value){return {limit(){return this;},get:async()=>{const docs=Object.keys(records).filter(k=>k.startsWith(name+'/')&&records[k][field]===value).map(k=>({...snap(k),ref:ref(k)}));return {docs,size:docs.length};}};}};},async runTransaction(fn){const writes=[];const value=await fn({get:q=>q.get(),set(r,data){writes.push(()=>{records[r.key]={...records[r.key],...data};});},update(r,data){if(failQueue&&r.key.startsWith('queue/'))throw new Error('Synthetic queue failure');writes.push(()=>{records[r.key]={...records[r.key],...data};});},delete(r){writes.push(()=>{delete records[r.key];});}});writes.forEach(w=>w());return value;}};
const firestore=()=>db;firestore.FieldValue={serverTimestamp:()=>0};
const config=require.resolve('../../src/config/firebase');
require.cache[config]={id:config,filename:config,loaded:true,exports:{admin:{firestore}}};
const controller=require('../../src/controllers/driverController');
function invoke(handler,body={},actor='staff') {return new Promise((resolve,reject)=>handler({params:{driverId:'driver-a'},body,user:{uid:actor},userData:{role:'admin'}},{json:resolve},reject));}
const data={name:'Synthetic Driver',phone:'09000000000',license:'L1',truckType:'4W',plateNumber:'TEST',truckingCompany:'Synthetic',helper:'',notes:''};
test.beforeEach(()=>{failQueue=false;records={'users/staff':{role:'admin',status:'active'},'users/driver-a':{role:'driver',status:'active'},'drivers/driver-a':{driverId:'driver-a',isFull:true},'queue/a':{driverId:'driver-a',status:'waiting',registrationComplete:false},'queue/b':{driverId:'driver-b',status:'waiting',registrationComplete:false},'queue/done':{driverId:'driver-a',status:'completed',registrationComplete:false}};});
test('R14 staff save updates only the selected driver active queues and preserves capacity',async()=>{await invoke(controller.saveDriverProfile,data);assert.equal(records['drivers/driver-a'].driverName,data.name);assert.equal(records['drivers/driver-a'].isFull,true);assert.equal(records['queue/a'].registrationComplete,true);assert.equal(records['queue/b'].registrationComplete,false);assert.equal(records['queue/done'].registrationComplete,false);});
test('R14 queue write failure rolls back profile edit',async()=>{failQueue=true;await assert.rejects(invoke(controller.saveDriverProfile,data),/Synthetic queue failure/);assert.equal(records['drivers/driver-a'].name,undefined);});
test('R14 transaction rejects stale demoted staff',async()=>{records['users/staff'].role='driver';await assert.rejects(invoke(controller.saveDriverProfile,data),e=>e.statusCode===403);});
test('R14 driver edit rejects privileged fields',async()=>{await assert.rejects(invoke(controller.saveDriverProfile,{...data,isFull:false}),e=>e.name==='ZodError');});
test('R14 cannot create a phone-keyed profile without registered identity',async()=>{delete records['drivers/driver-a'];delete records['users/driver-a'];await assert.rejects(invoke(controller.saveDriverProfile,data),e=>e.statusCode===409);});
test('R14 deletion preserves active accounts and queue history',async()=>{await assert.rejects(invoke(controller.deleteDriverProfile),e=>e.statusCode===409);assert.ok(records['drivers/driver-a']);assert.ok(records['queue/a']);});
