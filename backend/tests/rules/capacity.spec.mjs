import {before, after, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
let db, events;
before(() => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8085');
  admin.initializeApp({projectId:'demo-sysu-security'});
  db = admin.firestore();
  const path = require.resolve('../../src/config/firebase');
  require.cache[path] = {id:path,filename:path,loaded:true,exports:{admin}};
});
after(async () => {delete global._io; await db?.terminate(); await admin.app().delete();});
beforeEach(async () => {
  await db.recursiveDelete(db.collection('drivers'));
  await db.recursiveDelete(db.collection('queue'));
  await db.collection('drivers').doc('driver-a').set({isFull:false});
  for (const [id, status] of [['waiting','waiting'],['loaded','loaded'],['done','completed']]) {
    await db.collection('queue').doc(id).set({driverId:'driver-a', status, isFull:false});
  }
  events=[];
  global._io={emit:(event,data)=>events.push({room:'ALL',event,data}),to(room){return {emit:(event,data)=>events.push({room,event,data})};}};
});
function invoke(isFull) {
  return new Promise((resolve,reject) => {
    const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){resolve({status:this.statusCode,body});}};
    require('../../src/controllers/driverController').updateDriverFull({params:{driverId:'driver-a'},body:{isFull},user:{uid:'driver-a'},userData:{role:'driver'}},res,reject);
  });
}
function injectWriteFailure() {
  const originalTx=db.runTransaction.bind(db), originalBatch=db.batch.bind(db);
  db.runTransaction=callback=>originalTx(async tx=>{
    const update=tx.update.bind(tx);
    tx.update=(ref,...args)=>{if(ref.path.startsWith('queue/')) throw new Error('Synthetic queue write failure');return update(ref,...args);};
    return callback(tx);
  });
  db.batch=()=>{const batch=originalBatch();batch.commit=async()=>{throw new Error('Synthetic queue write failure');};return batch;};
  return ()=>{db.runTransaction=originalTx;db.batch=originalBatch;};
}
test('R10 REST queue write failure rolls back driver state and emits no event',async()=>{
  const restore=injectWriteFailure();
  try {await assert.rejects(invoke(true),/Synthetic queue write failure/);} finally {restore();}
  assert.equal((await db.collection('drivers').doc('driver-a').get()).data().isFull,false);
  assert.equal((await db.collection('queue').doc('waiting').get()).data().isFull,false);
  assert.deepEqual(events,[]);
});
test('R10 REST updates active loaded queue and only authorized recipients',async()=>{
  assert.equal((await invoke(true)).status,200);
  assert.equal((await db.collection('queue').doc('loaded').get()).data().isFull,true);
  assert.equal((await db.collection('queue').doc('done').get()).data().isFull,false);
  assert.equal(events[0]?.room,'dispatchers');
});
test('R10 concurrent capacity toggles leave driver and active queues coherent',async()=>{
  const results=await Promise.all([invoke(true),invoke(false)]);
  assert.deepEqual(results.map(r=>r.status),[200,200]);
  const driver=(await db.collection('drivers').doc('driver-a').get()).data();
  for (const id of ['waiting','loaded']) assert.equal((await db.collection('queue').doc(id).get()).data().isFull,driver.isFull);
});
test('R10 socket capacity updates driver and all active queues through the same atomic path',async()=>{
  const source=readFileSync(new URL('../../src/server.js',import.meta.url),'utf8');
  const handlers={};
  vm.runInNewContext(source.slice(source.indexOf('socket.on("driver_is_full"'),source.indexOf('socket.on("driver_moving"')),
    {socket:{data:{uid:'driver-a',role:'driver'},on(event,handler){handlers[event]=handler;}},admin,require:path=>path.includes('driverCapacity')?require('../../src/services/driverCapacity'):require(path),io:global._io,console:{log(){},error(){}}});
  await handlers.driver_is_full({isFull:true});
  assert.equal((await db.collection('drivers').doc('driver-a').get()).data().isFull,true);
  for (const id of ['waiting','loaded']) assert.equal((await db.collection('queue').doc(id).get()).data().isFull,true);
  assert.equal((await db.collection('queue').doc('done').get()).data().isFull,false);
  assert.equal(events[0]?.room,'dispatchers');
});
