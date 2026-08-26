const {admin} = require("../config/firebase");

const DB = () => admin.firestore();
const DRIVERS_COLLECTION = "drivers";

// GET /api/drivers/:driverId —— read driver doc (for sysu-go sync)
exports.getDriver = async (req, res) => {
    try {
        const {driverId} = req.params;
        if (!driverId) {
            return res.status(400).json({success: false, message: "driverId is required"});
        }
        const snap = await DB().collection(DRIVERS_COLLECTION).doc(driverId).get();
        if (!snap.exists) {
            return res.status(404).json({success: false, message: "Driver not found"});
        }
        return res.json({success: true, data: {id: snap.id, ...snap.data()}});
    } catch (error) {
        console.error("[Driver Controller] getDriver error:", error);
        return res.status(500).json({success: false, message: "Failed to get driver"});
    }
};

// PATCH /api/drivers/:driverId/full —— set isFull boolean on driver doc
// Called by sysu-go when driver presses "truck is full" / "truck has space again"
exports.updateDriverFull = async (req, res) => {
    try {
        const {driverId} = req.params;
        const {isFull} = req.body; // boolean

        if (typeof isFull !== "boolean") {
            return res.status(400).json({
                success: false,
                message: "isFull must be a boolean",
            });
        }

        const ref = DB().collection(DRIVERS_COLLECTION).doc(driverId);
        await ref.update({
            isFull,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Also update any active queue document for this driver
        const queueSnap = await DB().collection("queue")
            .where("driverId", "==", driverId)
            .where("status", "in", ["waiting", "called", "assigned", "loading"])
            .get();

        const batch = DB().batch();
        queueSnap.forEach((doc) => {
            batch.update(doc.ref, {
                isFull,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        });
        if (!queueSnap.empty) {
            await batch.commit();
        }

        // Broadcast to dispatchers via socket if available
        if (global._io) {
            global._io.emit("driver_capacity_updated", {driverId, isFull});
        }

        return res.json({success: true, driverId, isFull});
    } catch (error) {
        console.error("[Driver Controller] updateDriverFull error:", error);
        return res.status(500).json({success: false, message: "Failed to update driver fullness status"});
    }
};