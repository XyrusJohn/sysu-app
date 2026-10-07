const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../../src/server.js'),'utf8');
const middlewareStart=source.indexOf('io.use(async');
const connectionSource=source.slice(middlewareStart >= 0 ? middlewareStart : source.indexOf('io.on("connection"'),source.indexOf('\nserver.listen('));
async function connect(profile={role:'driver',status:'active'}) {
  const handlers={}; const emissions=[]; let writes=0; let disconnected=false;
  let profileListener, stoppedProfile=false;
  let onConnection;
  const middleware=[];
  const io={use(handler){middleware.push(handler);},on(_event,callback){onConnection=callback;},emit(...args){emissions.push(args);},to(){return this;}};
  const ref={update:async()=>{writes++;},set:async()=>{writes++;}};
  const query={where(){return this;},limit(){return this;},doc(){return {onSnapshot(listener){profileListener=listener;return ()=>{stoppedProfile=true;};},get:async()=>({exists:Boolean(profile),data:()=>profile})};},get:async()=>({empty:false,docs:[{id:'assignment-a',ref,data:()=>({driverId:'driver-a',tripStatus:'in_transit'})}]})};
  const firestore=()=>({collection:()=>query}); firestore.FieldValue={serverTimestamp:()=>0};
  const admin={firestore,auth:()=>({verifyIdToken:async()=>({uid:'driver-a',exp:Math.floor(Date.now()/1000)+3600})})};
  vm.runInNewContext(connectionSource,{io,admin,require:()=>admin,console:{log(){},warn(){},error(){}},
    setTimeout:()=>({unref(){}}),clearTimeout(){},lastDriverLocationPersist:new Map(),getDistanceMeters:()=>1000,LOCATION_PERSIST_THROTTLE_MS:600000,MIN_PERSIST_DISTANCE_METERS:100});
  const socket={handshake:{auth:{token:'synthetic'}},data:{},join(){},disconnect(){disconnected=true;handlers.disconnect?.();},once(event,handler){handlers[event]=handler;},on(event,handler){handlers[event]=handler;},emit(...args){emissions.push(args);}};
  for(const handler of middleware) {
    const error=await new Promise(resolve=>handler(socket,resolve));
    if(error) {disconnected=true; break;}
  }
  if(!disconnected) await onConnection(socket);
  return {handlers,emissions,authenticatedBeforeConnection:middleware.length>0,changeProfile(data){assert.equal(typeof profileListener,'function');profileListener({exists:Boolean(data),data:()=>data});},get stoppedProfile(){return stoppedProfile;},get writes(){return writes;},get disconnected(){return disconnected;}};
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
  assert.equal(session.writes,1); assert.equal(session.emissions.length,1);
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
