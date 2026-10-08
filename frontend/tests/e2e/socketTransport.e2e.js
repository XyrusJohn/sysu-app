import {test,expect} from '@playwright/test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const admin=require('../../../backend/node_modules/firebase-admin');
const {io}=require('socket.io-client');
const uid='e2e-socket-session',email='e2e-socket@example.invalid',password='Synthetic-Only-Password-123!';
test('Real Socket.IO disconnects on Auth-only revocation and reauthenticated token reconnects',async()=>{
  test.setTimeout(45000);
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBe('127.0.0.1:8085');expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBe('127.0.0.1:9099');
  admin.initializeApp({projectId:'demo-sysu-security'});const db=admin.firestore();let socket;
  async function token(){const response=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});expect(response.status).toBe(200);return (await response.json()).idToken;}
  function event(name,timeout){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.off(name,success);reject(new Error('Socket event timeout: '+name));},timeout);const success=value=>{clearTimeout(timer);resolve(value);};socket.once(name,success);});}
  try{
    await admin.auth().createUser({uid,email,password});await db.collection('users').doc(uid).set({role:'admin',status:'active'});
    socket=io('http://127.0.0.1:8080',{autoConnect:false,reconnection:false,transports:['websocket'],auth:{token:await token()}});
    let connected=event('connect',5000);socket.connect();await connected;
    await new Promise(r=>setTimeout(r,1200));const disconnected=event('disconnect',35000);await admin.auth().revokeRefreshTokens(uid);
    expect(await disconnected).toBe('io server disconnect');expect((await db.collection('users').doc(uid).get()).data().status).toBe('active');
    socket.auth={token:await token()};connected=event('connect',5000);socket.connect();await connected;expect(socket.connected).toBe(true);
  }finally{socket?.disconnect();await admin.auth().deleteUser(uid).catch(e=>{if(e.code!=='auth/user-not-found')throw e;});await db.collection('users').doc(uid).delete();await db.terminate();await admin.app().delete();}
});
