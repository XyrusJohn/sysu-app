const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
let records;
let clock = Date.now();
const realNow = Date.now;
const profiles={staff:{role:'admin',status:'active'},driver:{role:'driver',status:'active'},
  legacySuper:{role:'super_admin'},legacyAdmin:{role:'admin'},legacyQr:{role:'qr_generator'},
  inactiveStaff:{role:'super_admin',status:'inactive'},disabledStaff:{role:'super_admin',status:'disabled'},
  nullStatus:{role:'super_admin',status:null},unknownStatus:{role:'super_admin',status:'pending'}};
const fixtures = () => [
  {id:'unfinished',status:'waiting',registrationComplete:false,truckType:'4W',entryTime:1},
  {id:'called',status:'called',registrationComplete:true,truckType:'4w',entryTime:2,driverName:'Called Driver',plateNumber:'TEST-1'},
  {id:'waiting',status:'waiting',registrationComplete:true,truckType:'4W',entryTime:2,driverName:'<img onerror=alert(1)>',plateNumber:'TEST-2',token:'PRIVATE-TOKEN',driverPhone:'PRIVATE-PHONE'},
  {id:'assigned',status:'waiting',registrationComplete:true,isAssigned:true,truckType:'4W',entryTime:3},
  {id:'finished',status:'completed',registrationComplete:true,truckType:'4W',entryTime:0}
];
const db = {collection(name) {
  const filters = [];
  return {
    doc(uid) {return {get:async()=>({exists:Boolean(profiles[uid]),data:()=>profiles[uid]})};},
    where(field,op,value) {filters.push(row => op === 'in' ? value.includes(row[field]) : row[field] === value);return this;},
    orderBy() {return this;}, limit(n) {this.count=n;return this;},
    async get() {
      assert.equal(name,'queue');
      const docs=records.filter(row=>filters.every(fn=>fn(row)))
        .sort((a,b)=>a.entryTime-b.entryTime||a.id.localeCompare(b.id)).slice(0,this.count)
        .map(row=>({id:row.id,data:()=>row}));
      return {docs};
    }
  };
}};
const firebasePath=require.resolve('../../src/config/firebase');
require.cache[firebasePath]={id:firebasePath,filename:firebasePath,loaded:true,exports:{admin:{
  firestore:()=>db,auth:()=>({verifyIdToken:async token=>{
    if(!Object.hasOwn(profiles,token))throw new Error('invalid');return {uid:token};
  }})
}}};
const qr=require('../../src/controllers/qrController');
const invoke=handler=>new Promise((resolve,reject)=>handler({userData:{status:'active'}}, {set(){return this;},json:resolve},reject));
let server;
test.before(async()=>{
  const app=express();app.use('/api/qr',require('../../src/routes/qrRoute'));
  app.use((error,req,res,next)=>res.status(500).json({success:false}));
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
});
test.beforeEach(()=>{records=fixtures();clock+=11000;Date.now=()=>clock;});
test.after(async()=>{Date.now=realNow;await new Promise(resolve=>server.close(resolve));});
test('W-05 public positions include only registered waiting/called drivers without identities',async()=>{
  const response=await invoke(qr.getPublicQueue);
  assert.deepEqual(response.data.queues['4W'],[{position:1},{position:2}]);
  for(const secret of ['Called Driver','TEST-1','PRIVATE-TOKEN','PRIVATE-PHONE','unfinished'])
    assert.equal(JSON.stringify(response).includes(secret),false);
});
test('W-05 unregistered scan alone never appears on the board',async()=>{
  records=[fixtures()[0]];
  const response=await invoke(qr.getPublicQueue);
  assert.deepEqual(response.data.queues['4W'],[]);
});
test('W-05 authorized card projection keeps accurate identity/order and excludes unfinished/assigned entries',async()=>{
  const response=await invoke(qr.getQueueCards);
  assert.deepEqual(response.data.queues['4W'].map(row=>[row.position,row.driverName,row.plateNumber,row.status]),
    [[1,'Called Driver','TEST-1','called'],[2,'<img onerror=alert(1)>','TEST-2','waiting']]);
  for(const secret of ['PRIVATE-TOKEN','PRIVATE-PHONE','unfinished','assigned'])
    assert.equal(JSON.stringify(response).includes('"'+secret+'"'),false);
});
test('W-05 next uncached poll removes assigned driver and admits completed registration once',async()=>{
  records[0].registrationComplete=true;records[2].isAssigned=true;
  const response=await invoke(qr.getQueueCards);
  assert.equal(response.data.queues['4W'].length,2);
  assert.deepEqual(response.data.queues['4W'].map(row=>row.position),[1,2]);
});
test('G-28 web positions move three to two to one as preceding registered drivers are assigned',async()=>{
  records=[
    {id:'unregistered',truckType:'AUV',status:'waiting',registrationComplete:false,entryTime:0},
    ...[1,2,3].map(n=>({id:'driver-'+n,driverName:'Synthetic '+n,truckType:'AUV',status:'waiting',registrationComplete:true,entryTime:n}))
  ];
  const positions=async()=>{
    clock+=6000;
    const response=await invoke(qr.getQueueCards);
    return response.data.queues.AUV.map(row=>[row.driverName,row.position]);
  };
  assert.deepEqual(await positions(),[['Synthetic 1',1],['Synthetic 2',2],['Synthetic 3',3]]);
  records[1].isAssigned=true;records[1].status='loading';
  assert.deepEqual(await positions(),[['Synthetic 2',1],['Synthetic 3',2]]);
  records[2].isAssigned=true;records[2].status='loading';
  assert.deepEqual(await positions(),[['Synthetic 3',1]]);
});
test('W-05 driver details require staff authorization',async()=>{
  const url=`http://127.0.0.1:${server.address().port}/api/qr/queue-cards`;
  for(const [token,status] of [[null,401],['driver',403],['staff',200]]) {
    const response=await fetch(url,{headers:token?{Authorization:'Bearer '+token}:{}});
    assert.equal(response.status,status);
    const body=await response.json();
    if(status!==200)assert.equal(JSON.stringify(body).includes('Called Driver'),false);
  }
});
test('W-05 staff profiles without an explicit active status cannot read queue-card identities',async()=>{
  const url=`http://127.0.0.1:${server.address().port}/api/qr/queue-cards`;
  for(const token of ['legacySuper','legacyAdmin','legacyQr']){
    const response=await fetch(url,{headers:{Authorization:'Bearer '+token}});
    assert.equal(response.status,403,token);
    assert.equal(JSON.stringify(await response.json()).includes('Called Driver'),false);
  }
});
test('W-05 inactive, disabled and invalid staff statuses cannot read queue-card identities',async()=>{
  const url=`http://127.0.0.1:${server.address().port}/api/qr/queue-cards`;
  for(const token of ['inactiveStaff','disabledStaff','nullStatus','unknownStatus']){
    const response=await fetch(url,{headers:{Authorization:'Bearer '+token}});
    assert.equal(response.status,403,token);
    assert.equal(JSON.stringify(await response.json()).includes('Called Driver'),false);
  }
});
