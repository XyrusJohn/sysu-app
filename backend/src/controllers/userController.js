const {admin} = require('../config/firebase.js');
const {asyncWrapper} = require('../middleware/asyncWrapper.js');
const {z} = require('zod');

const POSITIONS = {admin: 'Admin', driver: 'Driver', fleet_manager: 'Fleet Manager',
    pending: 'Pending Approval', super_admin: 'Super Admin', qr_generator: 'QR Generator'};
const uidSchema = z.string().min(1).max(128).refine(value => !value.includes('/'));
const updateRoleSchema = z.object({uid: uidSchema, role: z.enum(Object.keys(POSITIONS))});
const failure = (statusCode, message) => Object.assign(new Error(message), {statusCode});
const active = data => data && (data.status || 'active') === 'active' && !data.deletionState;

// Both profiles are tracked transaction reads. A super-admin change always leaves
// its distinct, active super-admin reviewer intact; competing changes must retry.
async function readPolicy(db, tx, actorId, targetId, operation, nextRole) {
    const actor = (await tx.get(db.collection('users').doc(actorId))).data();
    const allowed = operation === 'delete' ? ['super_admin'] : ['admin', 'super_admin'];
    if (!active(actor) || !allowed.includes(actor.role)) throw failure(403, 'Admin privileges required');
    if (actorId === targetId) throw failure(403, 'Cannot change your own role or delete your own account');
    const targetRef = db.collection('users').doc(targetId);
    const snapshot = await tx.get(targetRef);
    if (!snapshot.exists) throw failure(404, 'User not found');
    const target = snapshot.data();
    if ((target.role === 'super_admin' || nextRole === 'super_admin') && actor.role !== 'super_admin') {
        throw failure(403, 'Only super-admins may change a super-admin account');
    }
    if (operation !== 'delete' && target.deletionState) throw failure(409, 'Account deletion is in progress or complete');
    return {targetRef, target};
}
function audit(db, tx, actorId, targetId, action, details = {}) {
    tx.set(db.collection('user_admin_audit').doc(), {actorId, targetId, action, ...details,
        createdAt: admin.firestore.FieldValue.serverTimestamp()});
}
function notify(uid, event, data) {
    if (global._io) global._io.to('user:' + uid).emit(event, data);
}

exports.updateUserRole = asyncWrapper(async (req, res) => {
    const {uid, role} = updateRoleSchema.parse(req.body);
    const db = admin.firestore();
    await db.runTransaction(async tx => {
        const {targetRef, target} = await readPolicy(db, tx, req.user.uid, uid, 'role', role);
        tx.update(targetRef, {role, status: role === 'pending' ? 'inactive' : 'active',
            position: POSITIONS[role], pendingRoleChange: null, forceRefresh: Date.now()});
        audit(db, tx, req.user.uid, uid, 'role_changed', {fromRole: target.role, toRole: role});
    });
    notify(uid, 'user_role_changed', {uid, role});
    res.json({success: true, message: 'User role updated successfully'});
});

exports.deleteUser = asyncWrapper(async (req, res) => {
    const {uid} = z.object({uid: uidSchema}).parse(req.body);
    const db = admin.firestore();
    const complete = await db.runTransaction(async tx => {
        const {targetRef, target} = await readPolicy(db, tx, req.user.uid, uid, 'delete');
        if (target.deletionState === 'complete') return true;
        tx.update(targetRef, {status: 'disabled', deletionState: 'pending', forceRefresh: Date.now()});
        audit(db, tx, req.user.uid, uid, 'deletion_requested');
        return false;
    });
    if (!complete) {
        try {
            await admin.auth().deleteUser(uid);
        } catch (error) {
            if (error.code !== 'auth/user-not-found') {
                throw failure(503, 'Account disabled; deletion incomplete. Retry deletion to finish.');
            }
        }
        // A disabled tombstone prevents stale clients recreating an active profile.
        // Assignment/POD history is retained. Retrying after either service fails is safe.
        await db.runTransaction(async tx => {
            const targetRef = db.collection('users').doc(uid);
            const target = (await tx.get(targetRef)).data();
            if (target?.deletionState === 'complete') return;
            if (target?.deletionState !== 'pending') throw failure(409, 'Deletion state changed');
            tx.set(targetRef, {uid, role: 'pending', status: 'disabled', deletionState: 'complete',
                deletedAt: admin.firestore.FieldValue.serverTimestamp()});
            tx.delete(db.collection('drivers').doc(uid));
            audit(db, tx, req.user.uid, uid, 'deletion_completed');
        });
    }
    notify(uid, 'account_deleted', {uid});
    res.json({success: true, message: 'User deleted successfully'});
});
