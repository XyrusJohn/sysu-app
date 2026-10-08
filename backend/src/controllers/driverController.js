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
