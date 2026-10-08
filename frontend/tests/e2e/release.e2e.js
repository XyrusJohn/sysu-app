import {test,expect} from '@playwright/test';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);const admin=require('../../../backend/node_modules/firebase-admin');
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
});
async function login(page){await page.goto('/');await page.locator('#email').fill('e2e-staff@example.invalid');await page.locator('#password').fill(password);await page.locator('#loginBtn').click();await expect(page).toHaveURL(/dashboard\.html/);await page.waitForFunction(()=>window.dashboard?.state.user?.id==='e2e-staff');}
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
test('Browser disabled profile ends an already authenticated dashboard session',async({page})=>{await login(page);await db.collection('users').doc('e2e-staff').update({status:'disabled'});await expect(page).toHaveURL(/\/$|index\.html/);});

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
