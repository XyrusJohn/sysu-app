const {admin} = require('../config/firebase');
const tokenService = require('./tokenService');
const PRE_TRANSIT = ['assigned', 'loading', 'loaded', 'fully_loaded'];
const conflict = message => ({status: 409, message});

/** Bind each cancellation to one assignment generation and one pending request. */
async function requestCancellation({dispatchKey, reason, requestedBy}) {
    const db = admin.firestore();
    const requestRef = db.collection('cancelRequests').doc();
    return db.runTransaction(async tx => {
        const ref = db.collection('sap_assignments').doc(dispatchKey);
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return {status: 404, message: 'Assignment not found.'};
        const assignment = snapshot.data();
        if (!PRE_TRANSIT.includes(assignment.tripStatus)) return conflict('Only pre-transit assignments may be cancelled.');
        if (assignment.pendingCancellationId) {
            const previous = await tx.get(db.collection('cancelRequests').doc(assignment.pendingCancellationId));
            if (previous.exists && previous.data().status === 'pending') return conflict('A cancellation request is already pending.');
        }
        tx.create(requestRef, {dispatchKey, reason, requestedBy, status: 'pending', action: 'cancel',
            assignmentAssignedAt: assignment.assignedAt || null,
            requestedAt: admin.firestore.FieldValue.serverTimestamp(), decidedBy: null, decidedAt: null,
            decision: null, cancelAudit: null});
        tx.update(ref, {pendingCancellationId: requestRef.id});
        return {status: 200, data: {requestId: requestRef.id}};
    });
}

async function pending(tx, ref) {
    const snap = await tx.get(ref);
    if (!snap.exists) return {error: {status: 404, message: 'Request not found.'}};
    const data = snap.data();
    if (data.status !== 'pending') return {error: conflict('Request already decided or revoked.')};
    return {data};
}

/** Decide and issue a token in one commit; transaction retries cannot create orphan tokens. */
async function decideOverride({requestId, decision, reason, decidedBy}) {
    const db = admin.firestore();
    return db.runTransaction(async tx => {
        const ref = db.collection('overrideRequests').doc(requestId);
        const request = await pending(tx, ref);
        if (request.error) return request.error;
        let tokenId = null, tokenExpiresAt = null;
        if (decision === 'approved') {
            const issued = await tokenService.issue({...request.data, requestId, issuedBy: decidedBy}, tx);
            tokenId = issued.tokenId;
            tokenExpiresAt = issued.expiresAt.toISOString();
        }
        tx.update(ref, {status: decision, decision, decidedBy,
            decidedAt: admin.firestore.FieldValue.serverTimestamp(),
            denyReason: decision === 'denied' ? reason || null : null, tokenId, tokenExpiresAt});
        return {status: 200, data: {requestId, status: decision, tokenId, tokenExpiresAt}};
    });
}

/** Revocation conflicts with any competing decision instead of overwriting it. */
async function revoke(collection, {requestId, uid}) {
    const db = admin.firestore();
    return db.runTransaction(async tx => {
        const ref = db.collection(collection).doc(requestId);
        const request = await pending(tx, ref);
        if (request.error) return request.error;
        if (request.data.requestedBy !== uid) return {status: 403, message: "Cannot revoke another user's request."};
        tx.update(ref, {status: 'revoked', decidedAt: admin.firestore.FieldValue.serverTimestamp()});
        return {status: 200, data: {requestId, status: 'revoked'}};
    });
}

function includesDispatch(queue, key) {
    return queue.assignedShipment === key || (Array.isArray(queue.assignedShipments)
        && queue.assignedShipments.some(item => (item.dispatchKey || item.id || item.obdNumber) === key));
}
async function findQueue(db, tx, assignment, key) {
    const snap = assignment.queueId
        ? [await tx.get(db.collection('queue').doc(assignment.queueId))]
        : (await tx.get(db.collection('queue').where('driverId', '==', assignment.driverId).limit(101))).docs;
    if (snap.length > 100) return {error: conflict('Queue history requires reconciliation.')};
    const matches = snap.filter(doc => doc.exists && doc.data().driverId === assignment.driverId
        && !['completed', 'complete', 'in_transit'].includes(doc.data().status)
        && includesDispatch(doc.data(), key));
    if (matches.length !== 1) return {error: conflict('Cannot identify one active queue entry for this assignment.')};
    return {doc: matches[0]};
}

async function cancelInTransaction(db, tx, request, decidedBy) {
    const key = request.dispatchKey;
    const ref = db.collection('sap_assignments').doc(key);
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return {error: conflict('Assignment no longer exists.')};
    const assignment = snapshot.data();
    const sameGeneration = assignment.assignedAt
        ? !!request.assignmentAssignedAt && assignment.assignedAt.isEqual?.(request.assignmentAssignedAt) === true
        : !request.assignmentAssignedAt;
    if (!sameGeneration) return {error: conflict('Cancellation request belongs to an older assignment. Submit a new request.')};
    if (!PRE_TRANSIT.includes(assignment.tripStatus)) return {error: conflict('Only pre-transit assignments may be cancelled.')};
    const queue = await findQueue(db, tx, assignment, key);
    if (queue.error) return queue;
    const images = await tx.get(ref.collection('pod_images').limit(101));
    if (images.size > 100) return {error: conflict('POD history requires reconciliation before cancellation.')};
    const data = queue.doc.data();
    const remaining = (Array.isArray(data.assignedShipments) ? data.assignedShipments : [])
        .filter(item => (item.dispatchKey || item.id || item.obdNumber) !== key);
    const audit = {reason: request.reason, cancelledBy: decidedBy,
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(), dispatchKey: key};
    const historyRef = db.collection('sap_assignment_history').doc(request.requestId);
    tx.create(historyRef, {...assignment, dispatchKey: key, tripStatus: 'cancelled', cancelAudit: audit});
    for (const image of images.docs) {
        tx.create(historyRef.collection('pod_images').doc(image.id), image.data());
        tx.delete(image.ref);
    }
    tx.delete(ref);
    tx.update(queue.doc.ref, {assignedShipments: remaining, activeShipmentsCount: remaining.length,
        isAssigned: remaining.length > 0, status: remaining.length ? data.status : 'waiting',
        overallTripStatus: remaining.length ? data.overallTripStatus || 'loading' : 'waiting',
        assignedShipment: remaining[0]?.dispatchKey || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(), cancelAudit: audit});
    return {audit};
}

/** Keep request decision, cancellation audit and exact queue membership atomic. */
async function decideCancellation({requestId, decision, reason, decidedBy}) {
    const db = admin.firestore();
    return db.runTransaction(async tx => {
        const ref = db.collection('cancelRequests').doc(requestId);
        const request = await pending(tx, ref);
        if (request.error) return request.error;
        const cancellation = decision === 'approved'
            ? await cancelInTransaction(db, tx, {...request.data, requestId}, decidedBy) : {};
        if (cancellation.error) return cancellation.error;
        tx.update(ref, {status: decision, decision, decidedBy,
            denyReason: decision === 'denied' ? reason || null : null,
            decidedAt: admin.firestore.FieldValue.serverTimestamp(), cancelAudit: cancellation.audit || null});
        return {status: 200, data: {requestId, status: decision}};
    });
}

module.exports = {requestCancellation, decideOverride, revoke, decideCancellation};
