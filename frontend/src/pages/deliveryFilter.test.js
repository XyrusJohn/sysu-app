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
