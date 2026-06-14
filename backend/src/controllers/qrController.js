const {admin} = require("../config/firebase");
const crypto = require("crypto");

const DB = () => admin.firestore();
const QR_TOKENS_COLLECTION = "qr_tokens";
const QUEUE_COLLECTION = "queue";
const TOKEN_EXPIRY_HOURS = 48;

module.exports = {
    generateToken: async (req, res) => {
        try {
            const randomPart = crypto.randomBytes(12).toString("hex").toUpperCase();
            const token = `SYS-${randomPart}`;

            await DB().collection(QR_TOKENS_COLLECTION).doc(token).set({
                token,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                expiresAt: admin.firestore.Timestamp.fromDate(
                    new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000)
                ),
                used: false,
                // Alias — same bool, clearer name for consumer code
                isUsed: false,
            });

            return res.status(200).json({
                success: true,
                token,
            });
        } catch (error) {
            console.error("[QR Controller] Generate Error:", error);
            return res.status(500).json({success: false, message: "Failed to generate token"});
        }
    },

    verifyToken: async (req, res) => {
        try {
            const {token} = req.query;

            if (!token) {
                return res.status(400).json({success: false, message: "Token is required"});
            }

            const tokenDoc = await DB().collection(QR_TOKENS_COLLECTION).doc(token).get();

            if (!tokenDoc.exists) {
                return res.status(404).json({success: false, message: "Invalid or expired token"});
            }

            const data = tokenDoc.data();

            if (data.used) {
                return res.status(410).json({success: false, message: "Token already used"});
            }

            await DB().collection(QR_TOKENS_COLLECTION).doc(token).update({used: true, isUsed: true});

            // Emit to public /qr namespace — command center (no auth) is listening there
            if (global._qrNs) global._qrNs.emit("qr_token_used", {token});

            return res.status(200).json({
                success: true,
                message: "Token verified",
                token,
            });
        } catch (error) {
            console.error("[QR Controller] Verify Error:", error);
            return res.status(500).json({success: false, message: "Internal server error"});
        }
    },

    scanToken: async (req, res) => {
        try {
            const {token, driverId, driverName, truckType, plateNumber, truckCompany, helperName} = req.body;

            if (!token || !driverId) {
                return res.status(400).json({success: false, message: "Missing token or driverId"});
            }
            if (!truckType || !plateNumber) {
                return res.status(400).json({success: false, message: "Missing truckType or plateNumber"});
            }

            // ── Atomic transaction: check used + create queue entry — prevents race condition
            // where two drivers scan the same token at the exact same moment.
            const queueSnapshot = await DB().collection(QUEUE_COLLECTION)
                .where("token", "==", token)
                .get();

            if (!queueSnapshot.empty) {
                return res.status(400).json({success: false, message: "Token already used to join queue"});
            }

            // Double-check the token isn't already marked used (covers verifyToken path)
            const tokenDoc = await DB().collection(QR_TOKENS_COLLECTION).doc(token).get();
            if (!tokenDoc.exists) {
                return res.status(401).json({success: false, message: "Invalid or expired token"});
            }
            if (tokenDoc.data().used) {
                return res.status(410).json({success: false, message: "Token has already been used"});
            }

            const SANITIZE = (str, max) => (str || "").replace(/[<>]/g, "").substring(0, max);

            const queueEntry = {
                driverId: SANITIZE(driverId, 100),
                driverName: SANITIZE(driverName, 100),
                token,
                truckType: SANITIZE(truckType, 50),
                plateNumber: SANITIZE(plateNumber, 20),
                truckCompany: SANITIZE(truckCompany, 100),
                helperName: SANITIZE(helperName, 100),
                status: "waiting",
                joinedAt: admin.firestore.FieldValue.serverTimestamp(),
                // Gate: driver not yet visibility in Fleet Manager until they complete Edit Driver (trip registration)
                registrationComplete: false,
            };

            const docRef = await DB().collection(QUEUE_COLLECTION).add(queueEntry);

            // Mark token as used — do this AFTER successful queue entry so command center
            // restarts QR immediately when a driver joins
            await DB().collection(QR_TOKENS_COLLECTION).doc(token).update({
                used: true,
                isUsed: true,
                queueId: docRef.id,
            });

            // Emit to public /qr namespace — command center (no auth) is listening there
            if (global._qrNs) global._qrNs.emit("qr_token_used", {token});

            return res.status(200).json({
                success: true,
                message: "Successfully joined the queue",
                queueId: docRef.id,
            });
        } catch (error) {
            console.error("[QR Controller] Scan Error:", error);
            return res.status(500).json({success: false, message: "Internal server error"});
        }
    },

    updateQueueStatus: async (req, res) => {
        try {
            const {queueId, status} = req.body;
            const callerUserId = req.user.uid;

            if (!queueId || !status) {
                return res.status(400).json({success: false, message: "Missing queueId or status"});
            }

            const validStatuses = ["waiting", "loading", "complete"];
            if (!validStatuses.includes(status)) {
                return res.status(400).json({success: false, message: "Invalid status value"});
            }

            // Verify caller is admin or super_admin
            const callerDoc = await admin.firestore().collection("users").doc(callerUserId).get();
            const callerData = callerDoc.data();
            if (!callerData || (callerData.role !== "admin" && callerData.role !== "super_admin")) {
                return res.status(403).json({success: false, message: "Forbidden: Admin access required"});
            }

            await DB().collection(QUEUE_COLLECTION).doc(queueId).update({
                status,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            return res.status(200).json({success: true, message: "Status updated"});
        } catch (error) {
            console.error("[QR Controller] Update Status Error:", error);
            return res.status(500).json({success: false, message: "Internal server error"});
        }
    },
};