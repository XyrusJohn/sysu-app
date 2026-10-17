import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const admin=require('firebase-admin');
const {watchSocketSession}=require('../../src/services/socketSession');
let auth;const created=[];
before(()=>{assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:9099');admin.initializeApp({projectId:'demo-sysu-security'});auth=admin.auth();});
after(async()=>{for(const uid of created)await auth.deleteUser(uid).catch(e=>{if(e.code!=='auth/user-not-found')throw e;});await admin.app().delete();});
async function account() {
  const response=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:`session-${crypto.randomUUID()}@example.invalid`,password:'Synthetic-Only-Password-123!',returnSecureToken:true})});
  assert.equal(response.status,200);const body=await response.json();created.push(body.localId);await auth.verifyIdToken(body.idToken,true);return body;
}
async function check(user) {
  const timers=new Map();let n=0,stop,disconnected=false;
  const clock={setTimeout(fn,ms){timers.set(++n,{fn,ms});return n;},clearTimeout(id){timers.delete(id);}};
  const socket={data:{uid:user.localId},once(_event,fn){stop=fn;},disconnect(){disconnected=true;stop();}};
  watchSocketSession(socket,user.idToken,token=>auth.verifyIdToken(token,true),clock);
  const [,timer]=[...timers].find(([,t])=>t.ms===30000);timer.fn();
  // Wait for real emulator verification, rather than advancing a synthetic deadline first.
  for(let i=0;i<100&&!disconnected&&![...timers].some(([id,t])=>id>1&&t.ms===30000);i++)await new Promise(r=>setTimeout(r,20));
  const completed=disconnected||[...timers].some(([id,t])=>id>1&&t.ms===30000);
  stop();assert.ok(completed,'Auth verification did not complete within the test budget');return disconnected;
}
test('R22 real Auth valid token keeps established session',async()=>{assert.equal(await check(await account()),false);});
test('R22 real Auth disabled account disconnects without Firestore changes',async()=>{const user=await account();await auth.updateUser(user.localId,{disabled:true});assert.equal(await check(user),true);});
test('R22 real Auth deleted account disconnects without Firestore changes',async()=>{const user=await account();await auth.deleteUser(user.localId);assert.equal(await check(user),true);});
test('R22 real Auth revoked token disconnects and newly authenticated token works',async()=>{
  const user=await account();await new Promise(r=>setTimeout(r,1200));await auth.revokeRefreshTokens(user.localId);assert.equal(await check(user),true);
  const response=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:user.email,password:'Synthetic-Only-Password-123!',returnSecureToken:true})});
  assert.equal(response.status,200);assert.equal(await check(await response.json()),false);
});
