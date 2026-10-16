const {admin} = require('../../config/firebase.js');
const {z} = require('zod');
const ROLES = ['admin', 'driver', 'fleet_manager', 'pending', 'super_admin', 'qr_generator'];
const POSITIONS = {admin:'Admin', driver:'Driver', fleet_manager:'Fleet Manager', pending:'Pending Approval', super_admin:'Super Admin', qr_generator:'QR Generator'};
function forbidden(message) { return Object.assign(new Error('Forbidden: ' + message), {statusCode:403}); }
function requireReviewer(data) {
    if (!data || !['admin','super_admin'].includes(data.role) || data.status !== 'active') throw forbidden('Admin privileges required');
}
function notify(event, result, uid) {
    if (!global._io) return;
    global._io.to('role-reviewers').emit(event, result);
    if (uid) global._io.to('user:' + uid).emit(event, result);
}
async function getRoleRequests(status = 'pending', reviewerId) {
    const db = admin.firestore();
    requireReviewer((await db.collection('users').doc(reviewerId).get()).data());
    if (!['all','pending','approved','rejected'].includes(status)) throw new Error('Invalid request status');
    let query = db.collection('role_requests');
    if (status !== 'all') query = query.where('status','==',status);
    const snap = await query.limit(200).get();
    return snap.docs.map(doc => ({id:doc.id, ...doc.data(), createdAt:doc.data().createdAt?.toDate?.().toISOString() || null}));
}
async function createRoleRequest({requesterId, requestedRole}) {
    const role = z.enum(ROLES).parse(requestedRole);
    const db = admin.firestore();
    const userRef = db.collection('users').doc(requesterId);
    const requestRef = db.collection('role_requests').doc();
    const result = await db.runTransaction(async tx => {
        const user = await tx.get(userRef);
        if (!user.exists) throw forbidden('Profile required');
        const data = user.data();
        if (data.pendingRoleChange) throw Object.assign(new Error('A role request is already pending'), {statusCode:409});
        const request = {requesterId, requesterName:data.displayName || data.name || 'User', requesterEmail:data.email || '', currentRole:data.role, requestedRole:role, status:'pending', createdAt:admin.firestore.FieldValue.serverTimestamp()};
        tx.set(requestRef,request);
        tx.update(userRef,{pendingRoleChange:role});
        return {id:requestRef.id, ...request, createdAt:new Date().toISOString()};
    });
    notify('role_request_created',result,requesterId);
    return result;
}
async function decide(requestId, reviewerId, approved, reason = '') {
    z.string().min(1).max(128).parse(requestId);
    const db = admin.firestore();
    const requestRef = db.collection('role_requests').doc(requestId);
    const result = await db.runTransaction(async tx => {
        const request = await tx.get(requestRef);
        const reviewer = await tx.get(db.collection('users').doc(reviewerId));
        requireReviewer(reviewer.data());
        if (!request.exists) throw Object.assign(new Error('Role request not found'), {statusCode:404});
        const data = request.data();
        if (data.requesterId === reviewerId) throw forbidden('Cannot review your own request');
        if (data.status !== 'pending') throw Object.assign(new Error('Request already decided'), {statusCode:409});
        const role = z.enum(ROLES).parse(data.requestedRole);
        const userRef = db.collection('users').doc(data.requesterId);
        const user = await tx.get(userRef);
        if (!user.exists) throw Object.assign(new Error('Requester not found'), {statusCode:404});
        if ((role === 'super_admin' || user.data().role === 'super_admin') && reviewer.data().role !== 'super_admin') throw forbidden('Only super-admins may change a super-admin role');
        if (approved && user.data().deletionState) throw Object.assign(new Error('Account deletion is in progress or complete'), {statusCode:409});
        if (user.data().pendingRoleChange !== role) throw Object.assign(new Error('Role request was superseded'), {statusCode:409});
        const status = approved ? 'approved' : 'rejected';
        tx.update(userRef,approved ? {role, status:role === 'pending' ? 'inactive' : 'active', position:POSITIONS[role], pendingRoleChange:null, forceRefresh:Date.now()} : {pendingRoleChange:null});
        tx.update(requestRef,{status, reviewerId, reviewedAt:admin.firestore.FieldValue.serverTimestamp(), rejectionReason:approved ? null : z.string().max(1000).parse(reason)});
        return {id:requestId, requesterId:data.requesterId, requestedRole:role, status};
    });
    notify('role_request_updated',result,result.requesterId);
    if (approved && global._io) global._io.to('user:' + result.requesterId).emit('user_role_changed',{uid:result.requesterId, role:result.requestedRole});
    return result;
}
const approveRoleRequest = (id,reviewer) => decide(id,reviewer,true);
const rejectRoleRequest = (id,reviewer,reason) => decide(id,reviewer,false,reason);
module.exports = {getRoleRequests,createRoleRequest,approveRoleRequest,rejectRoleRequest};
