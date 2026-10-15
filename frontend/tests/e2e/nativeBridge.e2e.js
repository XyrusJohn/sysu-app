import {test,expect} from '@playwright/test';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
const require=createRequire(import.meta.url);
const admin=require('../../../backend/node_modules/firebase-admin');
const password='Synthetic-Only-Password-123!';
const serial=process.env.SYSU_NATIVE_SERIAL || 'emulator-5554';
let db;
test.beforeAll(()=>{
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBe('127.0.0.1:8085');
  expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBe('127.0.0.1:9099');
  expect(process.env.SYSU_NATIVE_BRIDGE).toBe('1');
  admin.initializeApp({projectId:'demo-sysu-security'});db=admin.firestore();
});
test.afterAll(async()=>{await db.terminate();await admin.app().delete();});
async function phase(){return (await fetch('http://127.0.0.1:18082/phase')).json();}
async function acknowledge(value){
  const response=await fetch('http://127.0.0.1:18082/phase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ack:value})});
  expect(response.ok).toBe(true);
}
async function loginStaff(page) {
  await admin.auth().deleteUser('native-staff').catch(error=>{if(error.code!=='auth/user-not-found')throw error;});
  await admin.auth().createUser({uid:'native-staff',email:'native-staff@example.invalid',password});
  await db.collection('users').doc('native-staff').set({role:'admin',status:'active',name:'Synthetic Staff'});
  expect((await fetch('http://127.0.0.1:18082/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).ok).toBe(true);
  await page.route('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',route=>route.fulfill({contentType:'text/javascript',body:readFileSync(require.resolve('leaflet/dist/leaflet.js'),'utf8')}));
  await page.route('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',route=>route.fulfill({contentType:'text/css',body:readFileSync(require.resolve('leaflet/dist/leaflet.css'),'utf8')}));
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
  await page.goto('/');
  await page.locator('#email').fill('native-staff@example.invalid');
  await page.locator('#password').fill(password);
  await page.locator('#loginBtn').click();
  await expect(page).toHaveURL(/dashboard\.html/,{timeout:15000});
  await page.waitForFunction(()=>window.dashboard?.state.user?.id==='native-staff');
}
test('Native Android service drives both web maps through separate real backends',async({page},testInfo)=>{
  test.setTimeout(180000);
  await loginStaff(page);
  await page.evaluate(()=>window.dashboard.handleNavClick('tracking'));
  await page.waitForFunction(()=>window.dashboard._driverLocationSocket?.connected);
  await page.evaluate(()=>{
    window.__nativePackets=[];
    window.dashboard._driverLocationSocket.on('update_admin_map',packet=>{
      if(packet.driverId==='native-driver')window.__nativePackets.push({lat:packet.lat,status:packet.status,sapDocId:packet.sapDocId,timestamp:packet.timestamp});
    });
  });
  await expect(page.locator('#trackingConnLabel')).toContainText('Connected');
  const positions=()=>page.evaluate(()=>[window.map,window.__trackingMap].map(map=>{
    const marker=Object.values(map?._layers||{}).find(layer=>layer._sysuLocation
      && String(layer.getPopup()?.getContent()).includes('native-driver'));
    return marker?{lat:marker.getLatLng().lat,status:marker._sysuLocation.status}:null;
  }));
  const adb=path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe');
  const android=spawn(adb,['-s',serial,'shell','am','instrument','-w','-r','-e','class',
    'com.sysu.go.AndroidTrackingBridgeTest','com.sysu.go.debug.test/androidx.test.runner.AndroidJUnitRunner']);
  let output='';android.stdout.on('data',data=>{output+=data;});android.stderr.on('data',data=>{output+=data;});
  const finished=new Promise(resolve=>android.once('close',code=>resolve(code)));
  try {
    for(const [step,lat,status] of [['first',14.55,'online'],['background',14.56,'online'],['offline',14.56,'offline'],
      ['recovered',14.57,'online'],['returning',14.58,'returning_to_base'],['closed',null,null],['late',null,null]]) {
      await expect.poll(async()=>(await phase()).value,{timeout:45000}).toBe(step);
      await expect.poll(positions,{timeout:10000}).toEqual(lat===null?[null,null]:[{lat,status},{lat,status}]);
      if(step==='late') {
        expect(await page.evaluate(()=>window.__nativePackets.some(packet=>packet.lat===14.59))).toBe(false);
      }
      await acknowledge(step);
    }
    expect(await finished).toBe(0);
    expect(output).toMatch(/OK \(1 test\)/);
    expect(output).not.toMatch(/FAILURES!!!|Process crashed|INSTRUMENTATION_FAILED/);
    const packets=await page.evaluate(()=>window.__nativePackets);
    for(const latitude of [14.55,14.56,14.57,14.58])expect(packets.some(packet=>packet.lat===latitude)).toBe(true);
  } finally {
    const state=await page.evaluate(()=>{
      const tracking=window.dashboard.state.liveTracking['native-driver'];
      return {tracking,packets:window.__nativePackets,now:Date.now()};
    });
    await testInfo.attach('synthetic-tracking-state',{body:Buffer.from(JSON.stringify(state)),contentType:'application/json'});
    if(android.exitCode===null){android.kill();await finished;}
    writeFileSync(testInfo.outputPath('native-instrumentation.log'),output);
    await testInfo.attach('native-instrumentation',{body:Buffer.from(output),contentType:'text/plain'});
  }
});

test('Native QR decoder and registration form produce one registered kiosk card',async({page},testInfo)=>{
  test.setTimeout(90000);
  await loginStaff(page);
  await page.goto('/qr-generator.html');
  await expect(page.locator('#queue-access')).toHaveText('Staff queue view');
  await expect(page.locator('#body-AUV')).not.toContainText('Native Driver');
  const adb=path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe');
  const android=spawn(adb,['-s',serial,'shell','am','instrument','-w','-r','-e','class',
    'com.sysu.go.NativeWorkflowTest#scannedQrRegistersOnceThroughNativeForm',
    'com.sysu.go.debug.test/androidx.test.runner.AndroidJUnitRunner']);
  let output='';android.stdout.on('data',data=>{output+=data;});android.stderr.on('data',data=>{output+=data;});
  const finished=new Promise(resolve=>android.once('close',code=>resolve(code)));
  try {
    await expect(page.locator('#body-AUV')).toContainText('Native Driver',{timeout:45000});
    await expect(page.locator('#body-AUV')).toContainText('ABC-123');
    await expect(page.locator('#cnt-AUV')).toHaveText('1');
    expect(await finished).toBe(0);
    expect(output).toMatch(/OK \(1 test\)/);
    const state=await (await fetch('http://127.0.0.1:18082/state')).json();
    expect(state.queueCount).toBe(1);expect(state.queue.registrationComplete).toBe(true);
  } finally {
    if(android.exitCode===null){android.kill();await finished;}
    await testInfo.attach('native-registration',{body:Buffer.from(output),contentType:'text/plain'});
  }
});
