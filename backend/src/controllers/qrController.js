const {admin} = require("../config/firebase");
const crypto = require("crypto");
const {asyncWrapper} = require("../middleware/asyncWrapper.js");
const { z } = require("zod");

const DB = () => admin.firestore();
const QR_TOKENS_COLLECTION = "qr_tokens";
const QUEUE_COLLECTION = "queue";
const TOKEN_EXPIRY_HOURS = 48;
const PUBLIC_TRUCK_TYPES = ['AUV', '4W', '6W', '10W', '20F', '40F'];
let publicQueueCache;
let publicQueuePending;

async function getRegisteredQueue() {
    if (!publicQueueCache || publicQueueCache.expiresAt <= Date.now()) {
        if (!publicQueuePending) {
            publicQueuePending = (async () => {
                const snap = await DB().collection(QUEUE_COLLECTION)
                    .where('registrationComplete', '==', true)
                    .where('status', 'in', ['waiting', 'called'])
                    .orderBy('entryTime', 'asc').limit(101).get();
                const queues = Object.fromEntries(PUBLIC_TRUCK_TYPES.map(type => [type, []]));
                const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
                for (const doc of snap.docs.slice(0, 100)) {
                    const data = doc.data();
                    const type = text(data.truckType, 10).toUpperCase();
                    if (!PUBLIC_TRUCK_TYPES.includes(type) || data.isAssigned === true || data.registrationComplete !== true) continue;
                    queues[type].push({position: queues[type].length + 1,
                        driverName: text(data.driverName, 100), plateNumber: text(data.plateNumber, 20),
                        status: data.status === 'called' ? 'called' : 'waiting'});
                }
                publicQueueCache = {expiresAt: Date.now() + 5000,
                    data: {queues, truncated: snap.docs.length > 100, asOf: new Date().toISOString()}};
            })().finally(() => {publicQueuePending = null;});
        }
        await publicQueuePending;
    }
    return publicQueueCache.data;
}

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
    getPublicQueue: asyncWrapper(async (req, res) => {
        const data = await getRegisteredQueue();
        const queues = Object.fromEntries(Object.entries(data.queues)
            .map(([type, rows]) => [type, rows.map(({position}) => ({position}))]));
        return res.json({success: true, data: {...data, queues}});
    }),
    getQueueCards: asyncWrapper(async (req, res) => {
        // Defense in depth: role authorization also requires an explicitly active profile.
        if (!req.userData || (req.userData.status !== undefined && req.userData.status !== 'active')) {
            return res.status(403).json({success: false, message: 'Active staff account required'});
        }
        res.set('Cache-Control', 'no-store');
        return res.json({success: true, data: await getRegisteredQueue()});
    }),
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

        if (data.used || data.isUsed || !data.expiresAt || data.expiresAt.toMillis() <= Date.now()) {
            return res.status(410).json({success: false, message: "Token already used"});
        }

        return res.status(200).json({
            success: true,
            message: "Token verified",
            token,
        });
    }),

    scanToken: asyncWrapper(async (req, res) => {
        if (req.userData?.role !== 'driver' || req.userData?.status !== 'active') {
            return res.status(403).json({success: false, message: 'Active driver account required'});
        }
        const body = scanTokenSchema.parse(req.body);
        const {token, driverId, driverName, truckType, plateNumber, truckCompany, helperName} = body;
        if (driverId !== req.user.uid) {
            return res.status(403).json({success: false, message: "Cannot scan for another driver"});
        }

        const SANITIZE = (str, max) => (str || "").replace(/[<>]/g, "").substring(0, max);

        const result = await DB().runTransaction(async (tx) => {
            const tokenRef = DB().collection(QR_TOKENS_COLLECTION).doc(token);
            const tokenDoc = await tx.get(tokenRef);

            if (!tokenDoc.exists) {
                return {status: 401, message: "Invalid or expired token"};
            }
            const tokenData = tokenDoc.data();
            if (tokenData.used || tokenData.isUsed || !tokenData.expiresAt || tokenData.expiresAt.toMillis() <= Date.now()) {
                return {status: 410, message: "Token has already been used"};
            }

            // Serialize admission for this UID even when scans use different tokens.
            const admissionRef = DB().collection('qr_admissions').doc(driverId);
            await tx.get(admissionRef);
            const activeQueue = await tx.get(DB().collection(QUEUE_COLLECTION)
                .where('driverId', '==', driverId)
                .where('status', 'in', ['waiting', 'called', 'assigned', 'loading', 'loaded', 'fully_loaded', 'in_transit'])
                .limit(1));
            if (!activeQueue.empty) {
                return {status: 409, message: 'Driver already has an active queue entry'};
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
            tx.set(admissionRef, {queueId: newQueueRef.id, updatedAt: now});
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
