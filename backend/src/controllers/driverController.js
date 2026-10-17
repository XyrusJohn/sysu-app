const {admin} = require("../config/firebase");
const {asyncWrapper} = require("../middleware/asyncWrapper.js");
const { z } = require("zod");
const {updateDriverCapacity} = require('../services/driverCapacity');

const DB = () => admin.firestore();
const DRIVERS_COLLECTION = "drivers";

const updateFullSchema = z.object({
    isFull: z.boolean(),
});

// GET /api/drivers/:driverId —— read driver doc (for sysu-go sync)
exports.getDriver = asyncWrapper(async (req, res) => {
    const {driverId} = req.params;
    if (!driverId) {
        return res.status(400).json({success: false, message: "driverId is required"});
    }
    if (req.userData?.role === 'driver' && req.user.uid !== driverId) {
        return res.status(403).json({success: false, message: 'Cannot read another driver profile'});
    }
    const snap = await DB().collection(DRIVERS_COLLECTION).doc(driverId).get();
    if (!snap.exists) {
        return res.status(404).json({success: false, message: "Driver not found"});
    }
    const source = snap.data();
    const fields = ['driverId', 'driverName', 'plateNumber', 'truckType', 'truckCompany', 'helperName', 'isFull', 'status', 'updatedAt'];
    const data = Object.fromEntries(fields.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
    return res.json({success: true, data: {id: snap.id, ...data}});
});

// PATCH /api/drivers/:driverId/full —— set isFull boolean on driver doc
// Called by sysu-go when driver presses "truck is full" / "truck has space again"
exports.updateDriverFull = asyncWrapper(async (req, res) => {
    const {driverId} = req.params;
    if (req.userData?.role === 'driver' && req.user.uid !== driverId) {
        return res.status(403).json({success: false, message: 'Cannot change another driver capacity'});
    }
    const {isFull} = updateFullSchema.parse(req.body);

    await updateDriverCapacity(driverId, isFull);

    // Broadcast to dispatchers via socket if available
    if (global._io) {
        global._io.to('dispatchers').emit("driver_capacity_updated", {driverId, isFull});
    }

    return res.json({success: true, driverId, isFull});
});

const identifier = z.string().trim().min(1).max(128)
    .refine(value => !value.includes('/') && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
        && !['.', '..'].includes(value));
const profileSchema = z.object({
    name: z.string().trim().min(1).max(200),
    phone: z.string().trim().min(1).max(32),
    license: z.string().trim().max(128),
    truckType: z.string().trim().min(1).max(64),
    plateNumber: z.string().trim().min(1).max(64),
    truckingCompany: z.string().trim().max(200),
    helper: z.string().trim().max(200),
    notes: z.string().trim().max(2000),
}).strict();
const failure = (message, statusCode) => Object.assign(new Error(message), {statusCode});
async function checkStaff(tx, db, uid, roles) {
    const actor = await tx.get(db.collection('users').doc(uid));
    const data = actor.data();
    if (!actor.exists || !roles.includes(data?.role) || data?.status !== 'active') {
        throw failure('Staff authorization required', 403);
    }
}

exports.saveDriverProfile = asyncWrapper(async (req, res) => {
    const id = identifier.parse(req.params.driverId);
    const input = profileSchema.parse(req.body);
    const db = DB();
    await db.runTransaction(async tx => {
        await checkStaff(tx, db, req.user.uid, ['fleet_manager', 'admin', 'super_admin']);
        const target = await tx.get(db.collection('users').doc(id));
        const user = target.data();
        if (!target.exists || user?.role !== 'driver' || user?.status !== 'active') {
            throw failure('Select an active registered driver account; phone-only profiles require reconciliation', 409);
        }
        const queues = await tx.get(db.collection('queue').where('driverId', '==', id).limit(101));
        if (queues.size > 100) throw failure('Driver queues require reconciliation', 409);
        const updatedAt = admin.firestore.FieldValue.serverTimestamp();
        tx.set(db.collection('drivers').doc(id), {...input, driverId:id,
            driverName:input.name, truckCompany:input.truckingCompany, helperName:input.helper, updatedAt}, {merge:true});
        for (const queue of queues.docs) {
            const data = queue.data();
            if (data.registrationComplete === false && ['waiting', 'called', 'available', 'assigned', 'loading', 'loaded', 'fully_loaded'].includes(data.status)) {
                tx.update(queue.ref, {registrationComplete:true, updatedAt});
            }
        }
        tx.set(db.collection('driver_profile_audit').doc(), {actorId:req.user.uid, driverId:id, action:'save', updatedAt});
    });
    return res.json({success:true, driverId:id});
});

exports.deleteDriverProfile = asyncWrapper(async (req, res) => {
    const id = identifier.parse(req.params.driverId);
    const db = DB();
    await db.runTransaction(async tx => {
        await checkStaff(tx, db, req.user.uid, ['admin', 'super_admin']);
        const user = await tx.get(db.collection('users').doc(id));
        const queues = await tx.get(db.collection('queue').where('driverId', '==', id).limit(1));
        const assignments = await tx.get(db.collection('sap_assignments').where('driverId', '==', id).limit(1));
        if (user.exists || queues.size || assignments.size) {
            throw failure('Linked driver profile retained; use account administration or reconciliation', 409);
        }
        tx.delete(db.collection('drivers').doc(id));
        tx.set(db.collection('driver_profile_audit').doc(), {actorId:req.user.uid, driverId:id, action:'delete-orphan', updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    });
    return res.json({success:true, driverId:id});
});
