const {admin} = require('../config/firebase');
const ACTIVE_STATES = ['waiting', 'called', 'available', 'assigned', 'loading', 'loaded', 'fully_loaded'];

async function updateDriverCapacity(driverId, isFull, db = admin.firestore()) {
    if (typeof driverId !== 'string' || !driverId || driverId.length > 128 || driverId.includes('/') || typeof isFull !== 'boolean') {
        throw Object.assign(new Error('Invalid capacity request'), {statusCode:400});
    }
    const driverRef = db.collection('drivers').doc(driverId);
    const queueQuery = db.collection('queue').where('driverId', '==', driverId)
        .where('status', 'in', ACTIVE_STATES).limit(101);
    await db.runTransaction(async tx => {
        const driver = await tx.get(driverRef);
        if (!driver.exists) throw Object.assign(new Error('Driver not found'), {statusCode:404});
        const queues = await tx.get(queueQuery);
        if (queues.size > 100) throw Object.assign(new Error('Active queues require reconciliation'), {statusCode:409});
        const patch = {isFull, updatedAt:admin.firestore.FieldValue.serverTimestamp()};
        tx.update(driverRef, patch);
        for (const queue of queues.docs) tx.update(queue.ref, patch);
    });
}

module.exports = {updateDriverCapacity};
