const http = require('node:http');
const {createRequire} = require('node:module');
const requireBackend = createRequire(require.resolve('../../../backend/package.json'));
const admin = requireBackend('firebase-admin');

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8085'
    || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099') {
  throw new Error('Native fixtures require the isolated loopback emulators');
}
admin.initializeApp({projectId: 'demo-sysu-security'});
const db = admin.firestore();
const uid = 'native-driver';
const password = 'Synthetic-Only-Password-123!';
const queueId = 'native-queue';
const shipmentId = 'native-shipment';
const qrToken = 'SYS-NATIVE-AUTOMATION-QR';
let phase = {value:'idle',ack:'idle'};

async function reset(options) {
  phase = {value:'idle',ack:'idle'};
  for (const collection of ['queue', 'sap_assignments', 'driver_locations']) {
    const docs = await db.collection(collection).get();
    for (const doc of docs.docs.filter(doc => doc.id.startsWith('native-') || doc.data().driverId === uid)) {
      await db.recursiveDelete(doc.ref);
    }
  }
  await admin.auth().deleteUser(uid).catch(error => {
    if (error.code !== 'auth/user-not-found') throw error;
  });
  await admin.auth().createUser({uid, email: 'native-driver@example.invalid', password});
  await db.collection('users').doc(uid).set({role: 'driver', status: options.pending ? 'pending' : 'active',
    name: 'Native Driver', fn: 'Native', ln: 'Driver', mi: '', phone: '09000000000'});
  await db.collection('drivers').doc(uid).set({driverId: uid, driverName: 'Native Driver', name: 'Native Driver',
    fn: 'Native', ln: 'Driver', mi: '', phone: '09000000000', truckingCompany: options.blankCompany ? '' : 'Synthetic',
    truckType: 'AUV', plateNumber: 'TEST123', isFull: false, requirements: {aircon: true}});
  if (options.qr) await db.collection('qr_tokens').doc(qrToken).set({token:qrToken,used:false,isUsed:false,
    expiresAt:admin.firestore.Timestamp.fromMillis(Date.now()+300000)});
  if (options.queue || options.assignment) {
    await db.collection('queue').doc(queueId).set({driverId: uid, driverName: 'Native Driver',
      truckType: 'AUV', plateNumber: 'TEST123', helper: 'Synthetic Helper', status: 'waiting',
        registrationComplete: options.unregistered !== true, isAssigned: false, isFull: false,
      entryTime: admin.firestore.Timestamp.fromMillis(Date.now() - 1000),
      joinedAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000)});
  }
  if (options.ahead) {
    for (let number = 1; number <= options.ahead; number++) {
      await db.collection('queue').doc('native-ahead-' + number).set({driverId: 'native-other-' + number,
        driverName: 'Synthetic Other', truckType: 'AUV', plateNumber: 'OTHER', status: 'waiting',
        registrationComplete: true, isAssigned: false,
        entryTime: admin.firestore.Timestamp.fromMillis(Date.now() - 60000 + number),
        joinedAt: admin.firestore.Timestamp.fromMillis(Date.now() - 60000 + number)});
    }
  }
  if (options.history) {
    await db.collection('sap_assignments').doc('native-history').set({driverId: uid,
      tripStatus: 'completed', driverName: 'Native Driver', shipmentNumber: 'native-history',
      queueId: 'native-old-queue', truckPlate: 'OLD', lineItems: []});
  }
  if (options.assignment) {
    await db.collection('queue').doc(queueId).update({status: 'assigned', isAssigned: true, assignedShipment: shipmentId});
    await db.collection('sap_assignments').doc(shipmentId).set({driverId: uid, queueId,
      tripStatus: options.tripStatus || 'assigned', driverName: 'Native Driver',
      shipmentNumber: shipmentId, truckType: 'AUV', truckPlate: 'TEST123',
      driverConfirmed: false, guardVerified: false, lineItems: [
        {obdNumber: '000001', customerName: 'Synthetic Customer', quantity: 1},
        {obdNumber: '000002', customerName: 'Synthetic Customer Two', quantity: 2},
      ]});
  }
  return {uid, queueId, shipmentId};
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    if (req.method === 'GET' && req.url === '/qr.png') {
      const image = await require('qrcode').toBuffer(qrToken,{width:400,margin:4});
      res.setHeader('Content-Type','image/png');res.end(image);return;
    }
    let body = '';
    for await (const part of req) {
      body += part;
      if (body.length > 4096) throw new Error('Fixture payload too large');
    }
    const options = body ? JSON.parse(body) : {};
    let result;
    if (req.method === 'POST' && req.url === '/reset') result = await reset(options);
    else if (req.method === 'POST' && req.url === '/advance') {
      await db.collection('queue').doc('native-ahead-' + options.number).update({status: 'assigned', isAssigned: true});
      result = {ok: true};
    } else if (req.method === 'POST' && req.url === '/transition') {
      if (!['returning_to_base','completed'].includes(options.tripStatus)) throw new Error('Invalid fixture transition');
      await db.collection('sap_assignments').doc(shipmentId).update({tripStatus:options.tripStatus});
      result = {ok:true};
    } else if (req.url === '/phase' && ['GET','POST'].includes(req.method)) {
      if (req.method === 'POST') {
        if (typeof options.value === 'string') phase.value = options.value;
        if (typeof options.ack === 'string') phase.ack = options.ack;
      }
      result = phase;
    } else if (req.method === 'GET' && req.url === '/state') {
      const queues = await db.collection('queue').where('driverId','==',uid).get();
      const ownQueue = queues.docs[0];
      result = {queueCount:queues.size,queueId:ownQueue?.id || null,queue:ownQueue?.data() || null,
        shipment: (await db.collection('sap_assignments').doc(shipmentId).get()).data() || null,
        location: (await db.collection('driver_locations').doc(uid).get()).data() || null};
    } else {
      res.writeHead(404).end(JSON.stringify({error: 'Unknown fixture operation'}));
      return;
    }
    res.end(JSON.stringify(result));
  } catch (_) {
    res.writeHead(500).end(JSON.stringify({error: 'Isolated fixture operation failed'}));
  }
});
server.listen(18082, '127.0.0.1', () => console.log('Isolated native fixture ready'));
const stop = () => server.close(async () => {
  await db.terminate();
  await admin.app().delete();
  process.exit(0);
});
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
