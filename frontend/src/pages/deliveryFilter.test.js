import {beforeEach, expect, test, vi} from 'vitest';

vi.mock('../api/firebase.js', () => ({db: {}, auth: {}}));
vi.mock('../api/socket.js', () => ({EVENTS: {}, socket: {}, getDriverSocket: vi.fn(), connectDriverSocket: vi.fn()}));
vi.mock('../api/authService.js', () => ({AuthService: {}}));
vi.mock('../api/sapService.js', () => ({SAPService: {fetchShipments: vi.fn(), parseDate: value => value || '—'}}));
import {Dashboard} from './dashboard.js';
import {SAPService} from '../api/sapService.js';

const dispatch = '0010136559';
const stored = (tripStatus = 'returning_to_base') => ({
  driverId: 'test-driver', driverName: 'Test Driver', truckPlate: 'TEST-123', truckType: '4w', tripStatus,
  lineItems: [
    {obdNumber: '6801001522', customerName: 'Test Customer', actualDelDate: '/Date(1788912000000)/', quantity: 4, volume: 0.022, deliveryStatus: 'All Delivered', isPodCompleted: true, podImageUrl: 'saved_in_subcollection'},
    {obdNumber: '6801001523', customerName: 'Second Customer', quantity: 6, isPodCompleted: true, podImageUrl: 'saved_in_subcollection'},
  ],
});
let dashboard;
beforeEach(() => {
  document.body.innerHTML = '<table><tbody id="sapBody"></tbody><tbody id="sapDtlOBDLines"></tbody></table><input id="sapSearch"><span id="sapStatAll"></span><span id="sapStatDel"></span><span id="sapStatTransit"></span><span id="sapResultCount"></span><div id="sapDispatchDetail" class="hidden"></div>';
  dashboard = new Dashboard();
  dashboard.state.sapAssignments = {[dispatch]: stored()};
  SAPService.fetchShipments.mockResolvedValue([]);
});
async function render(filter = 'all') {
  await dashboard._syncSAP(true);
  dashboard.state.sapFilter = filter;
  dashboard._renderSapTable();
  return document.getElementById('sapBody');
}

test('stored assignment renders when absent from the unassigned SAP feed', async () => {
  const body = await render();
  expect(body.textContent).toContain('10136559');
  expect(body.textContent).toContain('Test Driver');
  expect(document.getElementById('sapStatAll').textContent).toBe('1');
});
test('completed trips remain visible in Delivered even with no SAP rows', async () => {
  dashboard.state.sapAssignments[dispatch] = stored('completed');
  expect((await render('delivered')).textContent).toContain('Test Driver');
});
test('returning shipment with all OBD PODs complete appears in Delivered with OBD previews', async () => {
  expect((await render('delivered')).textContent).toContain('Test Driver');
  expect(document.getElementById('sapStatDel').textContent).toBe('1');
  dashboard.openSapDispatchDetail(dispatch);
  const detail = document.getElementById('sapDtlOBDLines');
  expect(detail.textContent).toContain('6801001522');
  expect(detail.textContent).toContain('6801001523');
  expect(detail.textContent).toContain('Test Customer');
  expect(detail.querySelectorAll('button')).toHaveLength(2);
});
test('returning shipment with an incomplete OBD is not labelled delivered', async () => {
  dashboard.state.sapAssignments[dispatch].lineItems[1].isPodCompleted = false;
  const body = await render('delivered');
  expect(body.textContent).not.toContain('Test Driver');
  expect(document.getElementById('sapStatDel').textContent).toBe('0');
});
test('only fresh SAP shipments appear in For Assignment, with no duplicate assigned rows', async () => {
  SAPService.fetchShipments.mockResolvedValue([
    {SAPDispatchNumber: dispatch, OBDNumber: '6801001522', TruckType: '4w', Driver: '', PgiStatus: 'X'},
    {SAPDispatchNumber: '0010000001', OBDNumber: '000123', TruckType: '4w', Driver: '', PgiStatus: 'X'},
  ]);
  const body = await render('forAssignment');
  expect(body.textContent).toContain('10000001');
  expect(body.textContent).not.toContain('Test Driver');
  expect(document.getElementById('sapStatAll').textContent).toBe('2');
});
test.each(['all', 'forAssignment'])('temporary review dispatch appears in %s as view-only', async filter => {
  SAPService.fetchShipments.mockResolvedValue([{
    SAPDispatchNumber: '0010139586', OBDNumber: '000000', TruckType: '', Driver: 'F. PAANO',
    PlateNumber: 'NLC 1406', ShipmentStart: 'PT11H41M00S', ForwardingAgent: '0050000128', PgiStatus: 'X',
  }]);
  const body = await render(filter);
  expect(body.textContent).toContain('10139586');
  expect(body.textContent).toContain('F. PAANO');
  expect(body.textContent).toContain('NLC 1406');
  expect(body.textContent).toContain('Review only');
  expect(body.querySelector('button')).toBeNull();
});
test('search matches any OBD and Firestore text is escaped', async () => {
  dashboard.state.sapAssignments[dispatch].driverName = '<img src=x onerror=alert(1)>';
  document.getElementById('sapSearch').value = '6801001523';
  const body = await render();
  expect(body.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(body.querySelector('img')).toBeNull();
});
test('removing an assignment removes its display fallback on the next refresh', async () => {
  await render();
  delete dashboard.state.sapAssignments[dispatch];
  expect((await render()).textContent).not.toContain('Test Driver');
});
test('In Transit filter and counter use the stored trip lifecycle', async () => {
  dashboard.state.sapAssignments[dispatch] = stored('in_transit');
  expect((await render('in_transit')).textContent).toContain('Test Driver');
  expect(document.getElementById('sapStatTransit').textContent).toBe('1');
});
test('assigned detail keeps repeated stored OBD rows and quantities when SAP overlaps', async () => {
  const assignment = dashboard.state.sapAssignments[dispatch];
  assignment.lineItems.push({...assignment.lineItems[0], quantity: 2});
  SAPService.fetchShipments.mockResolvedValue([{SAPDispatchNumber: dispatch, OBDNumber: '6801001522', TruckType: '4w', Quantity: 999}]);
  await render();
  dashboard.openSapDispatchDetail(dispatch);
  expect(document.getElementById('sapDtlOBDLines').querySelectorAll('tr')).toHaveLength(3);
  expect(document.getElementById('sapDtlOBDLines').textContent).not.toContain('999');
});
test('stored dispatch labels and inline callback IDs cannot inject markup or script', async () => {
  const unsafeKey = "001'<img src=x onerror=alert(1)>";
  dashboard.state.sapAssignments = {[unsafeKey]: stored()};
  const body = await render();
  expect(body.querySelector('img')).toBeNull();
  const link = body.querySelector('[onclick]');
  expect(link.getAttribute('onclick')).toBe(`window.dashboard.openSapDispatchDetail('${encodeURIComponent(unsafeKey).replaceAll("'", '%27')}')`);
});
test('stored assignment action attributes cannot inject event handlers', async () => {
  const key = '001" onmouseover="alert(1)';
  dashboard.state.sapAssignments = {[key]: stored('assigned')};
  const body = await render('assigned');
  expect(body.querySelector('[onmouseover]')).toBeNull();
  expect(body.querySelector('select').dataset.dispatch).toBe(key);
});
test.each([1791476416000, {seconds: 1791476416}, undefined])('POD preview handles stored capture time %j without crashing', async podCapturedAt => {
  const assignment = dashboard.state.sapAssignments[dispatch];
  assignment.lineItems[0].podImageUrl = 'data:image/png;base64,AAAA';
  assignment.lineItems[0].podCapturedAt = podCapturedAt;
  document.body.insertAdjacentHTML('beforeend', '<div id="podPreviewModal" class="hidden"><img id="podPreviewImg"><span id="podTimestamp"></span><span id="podVerifiedTimestamp"></span></div>');
  dashboard._currentDispatchKey = dispatch;
  await expect(dashboard.openObdPodPreview('6801001522')).resolves.toBeUndefined();
  expect(document.getElementById('podPreviewModal').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('podTimestamp').textContent).not.toContain('Invalid Date');
  dashboard.closePodPreview();
});
