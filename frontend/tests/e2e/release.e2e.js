import {test,expect} from '@playwright/test';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);const admin=require('../../../backend/node_modules/firebase-admin');
const {io}=require('socket.io-client');
const password='Synthetic-Only-Password-123!';let db;
test.beforeAll(()=>{
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBe('127.0.0.1:8085');expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBe('127.0.0.1:9099');
  admin.initializeApp({projectId:'demo-sysu-security'});db=admin.firestore();
});
test.afterAll(async()=>{await db.terminate();await admin.app().delete();});
test.beforeEach(async({page})=>{
  for(const name of ['sap_assignments','sap_assignment_history','cancelRequests','overrideRequests'])await db.recursiveDelete(db.collection(name));
  await admin.auth().deleteUser('e2e-staff').catch(e=>{if(e.code!=='auth/user-not-found')throw e;});
  await admin.auth().createUser({uid:'e2e-staff',email:'e2e-staff@example.invalid',password});
  await db.collection('users').doc('e2e-staff').set({role:'admin',status:'active',name:'Synthetic Staff'});
  await db.collection('users').doc('e2e-driver').set({role:'driver',status:'active',name:'Synthetic Driver'});
  await db.collection('drivers').doc('e2e-driver').set({driverId:'e2e-driver',name:'Synthetic Driver',driverName:'Synthetic Driver',phone:'09000000000',truckType:'4W',plateNumber:'TEST',isFull:false});
  await db.collection('queue').doc('e2e-queue').set({driverId:'e2e-driver',driverName:'Synthetic Driver',truckType:'4W',plateNumber:'TEST',status:'waiting',registrationComplete:false,isAssigned:false,isFull:false,entryTime:admin.firestore.Timestamp.now()});
  await page.route('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',route=>route.fulfill({contentType:'text/javascript',body:readFileSync(require.resolve('leaflet/dist/leaflet.js'),'utf8')}));
  await page.route('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',route=>route.fulfill({contentType:'text/css',body:readFileSync(require.resolve('leaflet/dist/leaflet.css'),'utf8')}));
  // External typography is unrelated to these authenticated workflow assertions.
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
});
async function login(page){
  await page.goto('/');
  await page.locator('#email').fill('e2e-staff@example.invalid');
  await page.locator('#password').fill(password);
  await page.locator('#loginBtn').click();
  // Mobile Firebase Auth also initializes its Google iframe before password login.
  await expect(page).toHaveURL(/dashboard\.html/,{timeout:15000});
  await page.waitForFunction(()=>window.dashboard?.state.user?.id==='e2e-staff');
}
test('Browser staff login, profile save through real API and logout',async({page})=>{
  await login(page);
  await page.waitForFunction(()=>window.dashboard.state.drivers.some(driver=>driver.id==='e2e-driver'));
  await page.evaluate(()=>window.dashboard.openDrvModal('e2e-driver'));
  await page.locator('#drvFName').fill('Edited');await page.locator('#drvLName').fill('Driver');
  page.once('dialog',dialog=>dialog.accept());
  const response=page.waitForResponse(r=>r.url().endsWith('/api/drivers/e2e-driver/profile')&&r.request().method()==='PUT');
  await page.evaluate(()=>window.dashboard.saveDriver());expect((await response).status()).toBe(200);
  expect((await db.collection('drivers').doc('e2e-driver').get()).data().driverName).toBe('Edited Driver');
  expect((await db.collection('queue').doc('e2e-queue').get()).data().registrationComplete).toBe(true);
  await page.goto('/logout.html');await expect(page).toHaveURL(/\/$|index\.html/);await expect(page.locator('#loginBtn')).toBeVisible();
});
test('Browser anonymous dashboard returns to login',async({page})=>{await page.goto('/dashboard.html');await expect(page).toHaveURL(/\/$|index\.html/);});

test('Browser real GPS socket moves both Leaflet maps without rewinding or losing offline position',async({page})=>{
  test.setTimeout(45000);
  await admin.auth().deleteUser('e2e-driver').catch(e=>{if(e.code!=='auth/user-not-found')throw e;});
  await admin.auth().createUser({uid:'e2e-driver',email:'e2e-driver@example.invalid',password});
  await db.collection('sap_assignments').doc('e2e-tracking-trip').set({driverId:'e2e-driver',tripStatus:'in_transit',driverName:'Synthetic Driver'});
  await login(page);
  await page.evaluate(()=>window.dashboard.handleNavClick('tracking'));
  expect(await page.locator('#underDevOverlay').evaluate(el=>getComputedStyle(el).pointerEvents)).toBe('none');
  await expect(page.locator('#trackingConnLabel')).toContainText('Connected');
  const response=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic',
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'e2e-driver@example.invalid',password,returnSecureToken:true})});
  expect(response.status).toBe(200);
  const driver=io('http://127.0.0.1:18080',{autoConnect:false,reconnection:false,transports:['websocket'],auth:{token:(await response.json()).idToken}});
  const connected=new Promise((resolve,reject)=>{driver.once('connect',resolve);driver.once('connect_error',reject);});
  driver.connect();
  try {
    await connected;
    const timestamp=Date.now();
    driver.emit('driver_moving',{driverId:'e2e-driver',lat:14.5,lng:121,timestamp});
    const positions=()=>page.evaluate(()=>{
      const marker=map=>Object.values(map?._layers||{}).find(layer=>layer._sysuLocation);
      return [window.map,window.__trackingMap].map(map=>{const m=marker(map);return m?{lat:m.getLatLng().lat,status:m._sysuLocation.status}:null;});
    });
    await expect.poll(positions).toEqual([{lat:14.5,status:'online'},{lat:14.5,status:'online'}]);
    driver.emit('driver_moving',{driverId:'e2e-driver',lat:14.4,lng:121,timestamp:timestamp-60000});
    // FIFO transport delivers this newer sample after the old one; neither map may rewind.
    driver.emit('driver_moving',{driverId:'e2e-driver',lat:14.6,lng:121,timestamp:timestamp+1});
    await expect.poll(positions).toEqual([{lat:14.6,status:'online'},{lat:14.6,status:'online'}]);
    driver.emit('update_status',{driverId:'e2e-driver',status:'offline'});
    await expect.poll(positions).toEqual([{lat:14.6,status:'offline'},{lat:14.6,status:'offline'}]);
    await expect(page.locator('#trackingDriverList')).toContainText('Offline');
    await expect(page.locator('#trackingDriverCount, #trackingSidebarCount')).toHaveText(['0','0']);
    await page.evaluate(()=>{window.dashboard.handleNavClick('overview');window.dashboard.handleNavClick('tracking');});
    driver.emit('driver_moving',{driverId:'e2e-driver',lat:14.7,lng:121,timestamp:Date.now()});
    await expect.poll(positions).toEqual([{lat:14.7,status:'online'},{lat:14.7,status:'online'}]);
  } finally {driver.disconnect();}
});

test('Browser registered kiosk card appears after registration and disappears after assignment',async({page})=>{
  test.setTimeout(90000);
  await login(page);
  await page.goto('/qr-generator.html');
  await expect(page.locator('#queue-access')).toHaveText('Staff queue view');
  await expect(page.locator('#queue-status')).toContainText('Updated', {timeout:25000});
  await expect(page.locator('#body-4W')).not.toContainText('Synthetic Driver');
  await db.collection('queue').doc('e2e-queue').update({registrationComplete:true});
  await expect(page.locator('#body-4W')).toContainText('Synthetic Driver', {timeout:25000});
  await expect(page.locator('#body-4W')).toContainText('TEST');
  await expect(page.locator('#cnt-4W')).toHaveText('1');
  await db.collection('queue').doc('e2e-queue').update({status:'called'});
  await expect(page.locator('#body-4W')).toContainText('Tinatawag', {timeout:25000});
  await db.collection('queue').doc('e2e-queue').update({isAssigned:true,status:'loading'});
  await expect(page.locator('#body-4W')).not.toContainText('Synthetic Driver', {timeout:25000});
  await expect(page.locator('#cnt-4W')).toHaveText('0');
});

test('Browser legacy super-admin without status can see registered kiosk driver cards',async({page})=>{
  await db.collection('users').doc('e2e-staff').update({role:'super_admin',status:admin.firestore.FieldValue.delete()});
  await db.collection('queue').doc('e2e-queue').update({registrationComplete:true});
  await login(page);
  await page.goto('/qr-generator.html');
  await expect(page.locator('#queue-access')).toHaveText('Staff queue view');
  await expect(page.locator('#body-4W')).toContainText('Synthetic Driver',{timeout:25000});
  await expect(page.locator('#body-4W')).toContainText('TEST');
  await expect(page.locator('#cnt-4W')).toHaveText('1');
});

test('Browser deliveries use stored OBDs, show POD evidence and update without SAP membership',async({page})=>{
  const dispatch='0010136559',obd='6801001522',secondObd='6801001523';
  await db.collection('sap_assignments').doc(dispatch).set({driverId:'e2e-driver',driverName:'Stored Delivery Driver',truckType:'4w',truckPlate:'TEST',tripStatus:'returning_to_base',lineItems:[
    {obdNumber:obd,customerName:'Stored Customer',quantity:4,isPodCompleted:true,podImageUrl:'saved_in_subcollection',podCapturedAt:1791476416000},
    {obdNumber:secondObd,customerName:'Second Customer',quantity:6,isPodCompleted:true,podImageUrl:'saved_in_subcollection'},
  ]});
  await db.collection('sap_assignments').doc(dispatch).collection('pod_images').doc(obd).set({base64Image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='});
  await login(page);
  await page.waitForFunction(()=>Boolean(window.dashboard.state.sapAssignments['0010136559']));
  await page.evaluate(()=>window.dashboard.handleNavClick('sap'));
  await expect(page.locator('#sapBody')).toContainText('Stored Delivery Driver');
  await expect(page.locator('#sapBody')).toContainText('Returning to base');
  await page.locator('#sapSearch').fill(secondObd);
  await expect(page.locator('#sapBody')).toContainText('Stored Delivery Driver');
  await page.locator('#sapBody [onclick]').first().click();
  await expect(page.locator('#sapDtlOBDLines')).toContainText(obd);
  await expect(page.locator('#sapDtlOBDLines')).toContainText(secondObd);
  await page.locator('#sapDtlOBDLines button').first().click();
  await expect(page.locator('#podPreviewModal')).toBeVisible();
  await expect(page.locator('#podPreviewImg')).toHaveAttribute('src',/^data:image\/png;base64,/);
  await expect(page.locator('#podTimestamp')).not.toHaveText('Invalid Date');
  await page.evaluate(()=>{window.dashboard.closePodPreview();window.dashboard.closeSapDispatchModal();});
  await page.locator('#sapSearch').fill('');
  await page.locator('#sapTabForAssignment').click();
  await expect(page.locator('#sapBody')).not.toContainText('Stored Delivery Driver');
  await expect(page.locator('#sapBody')).toContainText('e2e-dispatch');
  await db.collection('sap_assignments').doc(dispatch).update({tripStatus:'in_transit'});
  await page.locator('#sapTabTransit').click();
  await expect(page.locator('#sapBody')).toContainText('Stored Delivery Driver');
  await db.collection('sap_assignments').doc(dispatch).delete();
  await expect(page.locator('#sapBody')).not.toContainText('Stored Delivery Driver');
});
test('Browser disabled profile ends an already authenticated dashboard session',async({page},testInfo)=>{
  await login(page);
  const profile=db.collection('users').doc('e2e-staff');
  const emulatorLogStart=readFileSync('firestore-debug.log','utf8').length;
  try {await profile.update({status:'disabled'});}
  catch(error) {
    // The emulator can commit before a closing watch breaks its write acknowledgement.
    const emulatorLog=readFileSync('firestore-debug.log','utf8').slice(emulatorLogStart);
    if(error.code!==2||!emulatorLog.includes('Stream is already completed, no further calls are allowed'))throw error;
    expect((await profile.get()).get('status')).toBe('disabled');
    testInfo.annotations.push({type:'emulator-warning',description:'Committed disabled profile verified after emulator closed-watch acknowledgement failure.'});
  }
  expect((await profile.get()).get('status')).toBe('disabled');
  await expect(page).toHaveURL(/\/$|index\.html/);
  await expect(page.locator('#loginBtn')).toBeVisible();
  await page.goto('/dashboard.html');
  await expect(page).toHaveURL(/\/$|index\.html/);
  await expect(page.locator('#loginBtn')).toBeVisible();
});

test('Browser SAP assignment, approved cancellation and reassignment preserve canonical driver identity',async({page})=>{
  await db.collection('queue').doc('e2e-queue').update({registrationComplete:true});
  await login(page);await page.waitForFunction(()=>window.dashboard.state.sapGroupedByDispatch['e2e-dispatch']?.length===1&&window.dashboard.state.queue.length>0);
  async function assign(){
    await page.evaluate(()=>window.dashboard.openAssignModal('e2e-dispatch','4W'));
    await page.locator('#assignModalDriverList .driver-row[data-id="e2e-queue"]').click();
    const response=page.waitForResponse(r=>r.url().endsWith('/api/sap/assign')&&r.request().method()==='POST');
    await page.locator('#assignConfirmBtn').click();expect((await response).status()).toBe(200);
  }
  await assign();
  let saved=(await db.collection('sap_assignments').doc('e2e-dispatch').get()).data();expect(saved.driverId).toBe('e2e-driver');expect(saved.lineItems[0].quantity).toBe(10);
  await page.waitForFunction(()=>Boolean(window.dashboard.state.sapAssignments['e2e-dispatch']));
  page.once('dialog',dialog=>dialog.accept());
  const requested=page.waitForResponse(r=>r.url().endsWith('/api/sap/cancel/request')&&r.request().method()==='POST');
  await page.evaluate(()=>window.dashboard._cancelAssignment('e2e-dispatch','Synthetic test cancellation',null,null));
  const requestResponse=await requested;expect(requestResponse.status()).toBe(200);const body=await requestResponse.json();const requestId=body.data?.requestId||body.requestId;expect(requestId).toBeTruthy();
  const approved=page.waitForResponse(r=>r.url().endsWith('/api/sap/cancel/decide')&&r.request().method()==='POST');
  await page.evaluate(id=>window.dashboard._adminDecide('cancel',id,'approved'),requestId);expect((await approved).status()).toBe(200);
  expect((await db.collection('sap_assignments').doc('e2e-dispatch').get()).exists).toBe(false);
  expect((await db.collection('sap_assignment_history').get()).size).toBe(1);
  await page.waitForFunction(()=>!window.dashboard.state.sapAssignments['e2e-dispatch']&&window.dashboard.state.queue.some(q=>q.id==='e2e-queue'&&q.status==='waiting'));
  await assign();saved=(await db.collection('sap_assignments').doc('e2e-dispatch').get()).data();expect(saved.driverId).toBe('e2e-driver');
});
