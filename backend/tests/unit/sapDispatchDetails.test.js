const test=require('node:test');
const assert=require('node:assert/strict');

const configPath=require.resolve('../../src/config/firebase');
const sapSourcePath=require.resolve('../../src/services/sapSource');
const controllerPath=require.resolve('../../src/controller/sapController');
const assignment={lineItems:[{obdNumber:'obd-allowed'}]};
const fakeDb={collection:name=>({doc:key=>({get:async()=>{
  assert.equal(name,'sap_assignments');
  return key==='dispatch-a'?{exists:true,data:()=>assignment}:{exists:false};
}})})};
require.cache[configPath]={id:configPath,filename:configPath,loaded:true,exports:{admin:{firestore:()=>fakeDb}}};
require.cache[sapSourcePath]={id:sapSourcePath,filename:sapSourcePath,loaded:true,exports:{
  read:async()=>({rows:[],detailRows:[]}),
  readDispatchDetails:async keys=>Object.fromEntries(keys.map(key=>[key,[
    {OBDNumber:'obd-allowed',Amount:100},
    {OBDNumber:'obd-not-on-assignment',Amount:999},
  ]]))},
};
delete require.cache[controllerPath];
const {getAssignedDispatchDetails}=require('../../src/controller/sapController');

function invoke(body) {
  return new Promise((resolve,reject)=>{
    const res={statusCode:200,headers:{},status(code){this.statusCode=code;return this;},set(name,value){this.headers[name]=value;return this;},json(payload){resolve({status:this.statusCode,headers:this.headers,body:payload});}};
    Promise.resolve(getAssignedDispatchDetails({body},res)).catch(reject);
  });
}

test('dispatch detail projection only returns OBD rows belonging to existing assignments',async()=>{
  const result=await invoke({dispatchKeys:['dispatch-a','missing','dispatch-a']});
  assert.equal(result.status,200);
  assert.equal(result.headers['Cache-Control'],'no-store');
  assert.deepEqual(result.body.data['dispatch-a'],[{OBDNumber:'obd-allowed',Amount:100}]);
  assert.equal(Object.hasOwn(result.body.data,'missing'),false);
});

test('dispatch detail projection bounds and validates the requested dispatch list',async()=>{
  assert.equal((await invoke({dispatchKeys:[]})).status,400);
  assert.equal((await invoke({dispatchKeys:Array.from({length:101},(_,index)=>`dispatch-${index}`)})).status,400);
  assert.equal((await invoke({dispatchKeys:['../other']})).status,400);
});
