const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../../src/server.js'),'utf8');
const middlewareStart=source.indexOf('io.use(async');
const connectionSource=source.slice(middlewareStart >= 0 ? middlewareStart : source.indexOf('io.on("connection"'),source.indexOf('\nserver.listen('));
async function connect(profile={role:'driver',status:'active'}, options={}) {
  const handlers={}; const emissions=[]; const logs=[]; let writes=0; let disconnected=false;
  let profileListener, stoppedProfile=false;
  let onConnection;
  const middleware=[];
  const io={use(handler){middleware.push(handler);},on(_event,callback){onConnection=callback;},emit(...args){emissions.push(args);},to(){return this;}};
  let failWrites=false;
  const ref={update:async()=>{writes++;},set:async()=>{writes++;if(failWrites) throw new Error('Synthetic database outage');}};
  const query={where(){return this;},limit(){return this;},doc(){return {onSnapshot(listener){profileListener=listener;return ()=>{stoppedProfile=true;};},get:async()=>({exists:Boolean(profile),data:()=>profile})};},get:async()=>({empty:false,docs:Array.from({length:options.assignmentCount || 1},(_,n)=>({id:`assignment-${n}`,ref,data:()=>({driverId:'driver-a',tripStatus:'in_transit'})}))})};
  const fakeDb={collection:name=>name === 'sap_assignments' ? {...query,doc:()=>({get:async()=>({exists:true,data:()=>({driverId:options.assignmentOwner || 'driver-a'})})})} : query,
    runTransaction:async callback=>callback({get:ref=>ref.get(),update(){writes++;}})};
  const firestore=()=>fakeDb; firestore.FieldValue={serverTimestamp:()=>0};
  const admin={firestore,auth:()=>({verifyIdToken:async()=>({uid:'driver-a',exp:Math.floor(Date.now()/1000)+3600})})};
  const capture=(...args)=>logs.push(args.join(' '));
  vm.runInNewContext(connectionSource,{io,admin,require:path=>path.includes('driverCapacity')
    ? {updateDriverCapacity:(id,flag)=>require('../../src/services/driverCapacity').updateDriverCapacity(id,flag,fakeDb)} : admin,console:{log:capture,warn:capture,error:capture},
    setTimeout:()=>({unref(){}}),clearTimeout(){},lastDriverLocationPersist:new Map(),getDistanceMeters:()=>1000,LOCATION_PERSIST_THROTTLE_MS:600000,MIN_PERSIST_DISTANCE_METERS:100});
  const socket={handshake:{auth:{token:'synthetic'}},data:{},join(){},disconnect(){disconnected=true;handlers.disconnect?.();},once(event,handler){handlers[event]=handler;},on(event,handler){handlers[event]=handler;},emit(...args){emissions.push(args);}};
  for(const handler of middleware) {
    const error=await new Promise(resolve=>handler(socket,resolve));
    if(error) {disconnected=true; break;}
  }
  if(!disconnected) await onConnection(socket);
  return {handlers,emissions,logs,authenticatedBeforeConnection:middleware.length>0,set failWrites(value){failWrites=value;},changeProfile(data){assert.equal(typeof profileListener,'function');profileListener({exists:Boolean(data),data:()=>data});},get stoppedProfile(){return stoppedProfile;},get writes(){return writes;},get disconnected(){return disconnected;}};
}
test('R10: capacity socket cannot impersonate a different driver',async()=>{
  const session=await connect(); await session.handlers.driver_is_full({driverId:'driver-b',isFull:true});
  assert.equal(session.writes,0); assert.equal(session.emissions.length,0);
});
test('R10: status and stopped sockets cannot impersonate another driver',async()=>{
  const session=await connect(); session.handlers.update_status({driverId:'driver-b',status:'stopped'});
  session.handlers.driver_stopped({driverId:'driver-b'});
  assert.equal(session.emissions.length,0);
});
test('R25: malformed location never throws or broadcasts',async()=>{
  const session=await connect();
  for(const payload of [null,{}, {driverId:'driver-a',lat:NaN,lng:10},{driverId:'driver-a',lat:91,lng:10},{driverId:'driver-a',lat:10,lng:181}]) {
    assert.doesNotThrow(()=>session.handlers.driver_moving(payload));
  }
  assert.equal(session.emissions.length,0); assert.equal(session.writes,0);
});
test('R10/R22: disabled and missing profiles register no handlers',async()=>{
  for(const profile of [null,{role:'driver',status:'disabled'},{role:'driver',status:'inactive'}]) {
    const session=await connect(profile); assert.equal(session.disconnected,true); assert.deepEqual(Object.keys(session.handlers),[]);
  }
});
test('R10: legitimate own capacity change still persists and notifies',async()=>{
  const session=await connect(); await session.handlers.driver_is_full({driverId:'driver-a',isFull:true});
  assert.equal(session.writes,2); assert.equal(session.emissions.length,1);
});
test('R10: auth finishes in middleware before connection handlers can register',async()=>{
  const session=await connect(); assert.equal(session.authenticatedBeforeConnection,true);
});
test('R22: established socket disconnects and cleans listener when account changes',async()=>{
  for(const data of [null,{role:'driver',status:'disabled'},{role:'viewer',status:'active'}]) {
    const session=await connect();session.changeProfile(data);
    assert.equal(session.disconnected,true);assert.equal(session.stoppedProfile,true);
  }
});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('R39: failed GPS persistence does not suppress the next retry',async()=>{
  const session=await connect();session.failWrites=true;
  session.handlers.driver_moving({driverId:'driver-a',lat:14,lng:121});await flush();
  session.failWrites=false;
  session.handlers.driver_moving({driverId:'driver-a',lat:14,lng:121});await flush();
  assert.equal(session.writes,2);
});
test('R39: GPS persists for every active assignment and accepts zero coordinates',async()=>{
  const session=await connect({role:'driver',status:'active'},{assignmentCount:2});
  session.handlers.driver_moving({driverId:'driver-a',lat:0,lng:0});await flush();
  assert.equal(session.writes,2);
});
test('R27: driver events do not log payload tokens email or POD URLs',async()=>{
  const session=await connect();
  session.handlers.driver_moving({driverId:'driver-a',lat:14,lng:121,token:'SYNTHETIC-SECRET',email:'private@example.invalid',podUrl:'https://example.invalid/private-photo'});
  session.handlers.update_status({driverId:'driver-a',status:'online',token:'SYNTHETIC-SECRET'});
  await flush();
  assert.equal(session.logs.join('\n').includes('SYNTHETIC-SECRET'),false);
  assert.equal(session.logs.join('\n').includes('private@example.invalid'),false);
  assert.equal(session.logs.join('\n').includes('private-photo'),false);
});
test('R10: driver cannot announce a POD for another driver assignment',async()=>{
  const session=await connect({role:'driver',status:'active'},{assignmentOwner:'driver-b'});
  await session.handlers.pod_updated({shipmentDocId:'shipment-b'});
  assert.equal(session.emissions.length,0);
});
test('R10/R27: owned mobile POD notification contains no arbitrary private payload',async()=>{
  const session=await connect();
  await session.handlers.pod_updated({shipmentDocId:'shipment-a',source:'driver_app',podUrl:'https://example.invalid/private-photo',token:'SYNTHETIC-SECRET'});
  assert.equal(session.emissions.length,1);
  assert.equal(session.emissions[0][1].shipmentDocId,'shipment-a');
  assert.equal(session.emissions[0][1].podUrl,undefined);
  assert.equal(session.emissions[0][1].token,undefined);
  assert.equal(session.logs.join('\n').includes('SYNTHETIC-SECRET'),false);
});
