const {admin} = require("../config/firebase");
const crypto = require("crypto");
const {asyncWrapper} = require("../middleware/asyncWrapper.js");
const { z } = require("zod");

const DB = () => admin.firestore();
const QR_TOKENS_COLLECTION = "qr_tokens";
const QUEUE_COLLECTION = "queue";
const TOKEN_EXPIRY_HOURS = 48;

const scanTokenSchema = z.object({
    token: z.string().min(1),
    driverId: z.string().min(1),
    driverName: z.string().optional(),
    truckType: z.string().min(1),
    plateNumber: z.string().min(1),
    truckCompany: z.string().optional(),
    helperName: z.string().optional(),
});

const updateStatusSchema = z.object({
    queueId: z.string().min(1),
    status: z.enum(["waiting", "loading", "complete"]),
});

module.exports = {
    generateToken: asyncWrapper(async (req, res) => {
        const randomPart = crypto.randomBytes(12).toString("hex").toUpperCase();
        const token = `SYS-${randomPart}`;

        await DB().collection(QR_TOKENS_COLLECTION).doc(token).set({
            token,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromDate(
                new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000)
            ),
            used: false,
            isUsed: false,
        });

        return res.status(200).json({
            success: true,
            token,
        });
    }),

    verifyToken: asyncWrapper(async (req, res) => {
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

        if (global._qrNs) global._qrNs.emit("qr_token_used", {token});

        return res.status(200).json({
            success: true,
            message: "Token verified",
            token,
        });
    }),

    scanToken: asyncWrapper(async (req, res) => {
        const body = scanTokenSchema.parse(req.body);
        const {token, driverId, driverName, truckType, plateNumber, truckCompany, helperName} = body;

        const SANITIZE = (str, max) => (str || "").replace(/[<>]/g, "").substring(0, max);

        const result = await DB().runTransaction(async (tx) => {
            const tokenRef = DB().collection(QR_TOKENS_COLLECTION).doc(token);
            const tokenDoc = await tx.get(tokenRef);

            if (!tokenDoc.exists) {
                return {status: 401, message: "Invalid or expired token"};
            }
            const tokenData = tokenDoc.data();
            if (tokenData.used || tokenData.isUsed) {
                return {status: 410, message: "Token has already been used"};
            }

            const newQueueRef = DB().collection(QUEUE_COLLECTION).doc();
            const now = admin.firestore.FieldValue.serverTimestamp();

            const queueEntry = {
                driverId: SANITIZE(driverId, 100),
                driverName: SANITIZE(driverName, 100),
                token,
                truckType: SANITIZE(truckType, 50),
                plateNumber: SANITIZE(plateNumber, 20),
                truckCompany: SANITIZE(truckCompany, 100),
                helperName: SANITIZE(helperName, 100),
                status: "waiting",
                entryTime: now,
                joinedAt: now,
                registrationComplete: false,
                isAssigned: false,
                isFull: false,
            };

            tx.set(newQueueRef, queueEntry);
            tx.update(tokenRef, {
                used: true,
                isUsed: true,
                queueId: newQueueRef.id,
                usedAt: now,
                usedBy: SANITIZE(driverId, 100),
            });

            return {status: 200, queueId: newQueueRef.id};
        });

        if (result.status !== 200) {
            return res.status(result.status).json({success: false, message: result.message});
        }

        if (global._qrNs) global._qrNs.emit("qr_token_used", {token});

        return res.status(200).json({
            success: true,
            message: "Successfully joined the queue",
            queueId: result.queueId,
        });
    }),

    updateQueueStatus: asyncWrapper(async (req, res) => {
        const {queueId, status} = updateStatusSchema.parse(req.body);

        await DB().collection(QUEUE_COLLECTION).doc(queueId).update({
            status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.status(200).json({success: true, message: "Status updated"});
    }),
};
