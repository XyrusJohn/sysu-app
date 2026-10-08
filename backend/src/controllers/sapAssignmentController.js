// sapAssignmentController — server-authoritative FIFO assignment.
//
// All writes to sap_assignments/{dispatchKey} and the relevant queue entry
// go through here. Direct client writes are blocked by Firestore rules.

const {admin} = require("../config/firebase.js");
const {resolveEarliest, validateEarliest} = require("../services/queueOrdering.js");
const tokenService = require("../services/tokenService.js");
const decisions = require("../services/dispatchDecisions.js");
const {asyncWrapper} = require("../middleware/asyncWrapper.js");
const { z } = require("zod");

const DB = () => admin.firestore();
const QUEUE_COLLECTION = "queue";
const SAP_COLLECTION = "sap_assignments";
const OVERRIDE_REQUESTS = "overrideRequests";
const CANCEL_REQUESTS = "cancelRequests";

// ── Validation Schemas ─────────────────────────────────────────────────────────────

const documentIdSchema = z.string().min(1).max(128).refine(value => value === value.trim()
    && !value.includes('/') && value !== '.' && value !== '..' && !/^__.*__$/.test(value)
    && [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), 'Invalid document identifier');
const reasonSchema = z.string().trim().min(1).max(2000);
const quantitySchema = z.number().finite().positive().max(Number.MAX_SAFE_INTEGER);

const lineItemSchema = z.object({
    obdNumber: documentIdSchema,
    quantity: z.union([quantitySchema, z.string().max(32).regex(/^\d+(\.\d+)?$/).transform(Number).pipe(quantitySchema)]),
    customerName: z.string().trim().min(1).max(500),
    amount: z.undefined().optional(), // Explicitly forbid amount
});

const assignDriverSchema = z.object({
    dispatchKey: documentIdSchema,
    requestedDriverId: documentIdSchema,
    truckType: z.string().trim().min(1).max(64),
    overrideTokenId: documentIdSchema.nullish(),
    driverSnapshot: z.any().optional(),
    lineItems: z.array(lineItemSchema).min(1).max(500),
});

const overrideRequestSchema = z.object({
    dispatchKey: documentIdSchema,
    requestedDriverId: documentIdSchema,
    reason: reasonSchema,
});

const overrideDecisionSchema = z.object({
    requestId: documentIdSchema,
    decision: z.enum(["approved", "denied"]),
    reason: reasonSchema.optional(),
});

const cancelRequestSchema = z.object({
    dispatchKey: documentIdSchema,
    reason: reasonSchema,
});

const cancelDecisionSchema = z.object({
    requestId: documentIdSchema,
    decision: z.enum(["approved", "denied"]),
    reason: reasonSchema.optional(),
});

const revokeSchema = z.object({
    requestId: documentIdSchema,
});

// ── Helpers ──────────────────────────────────────────────────────────────────────

function toMillis(value) {
    if (!value) return null;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (value instanceof Date) return value.getTime();
    if (typeof value === "object" && typeof value._seconds === "number") {
        return value._seconds * 1000;
    }
    return null;
}

async function loadQueueForType(truckType, transaction) {
    const ref = DB().collection(QUEUE_COLLECTION);
    const snap = transaction ? await transaction.get(ref) : await ref.get();
    const wanted = (truckType || "").trim().toLowerCase();
    const all = [];
    snap.forEach((doc) => {
        const data = doc.data();
        if (wanted) {
            const tt = (data.truckType || "").toString().trim().toLowerCase();
            if (tt !== wanted) return;
        }
        all.push({id: doc.id, ...data});
    });
    return all;
}

// ── Handlers ─────────────────────────────────────────────────────────────────────

exports.peekEarliest = asyncWrapper(async (req, res) => {
    const dispatchKey = (req.query.dispatchKey || "").toString().trim();
    const truckType = (req.query.truckType || "").toString().trim();
    if (!dispatchKey) {
        return res.status(400).json({success: false, message: "dispatchKey is required"});
    }

    const queue = await loadQueueForType(truckType);
    const {earliest, alternates} = resolveEarliest(queue, truckType);

    return res.json({
        success: true,
        data: {
            dispatchKey,
            requiredTruckType: truckType,
            earliest: earliest
                ? {
                      id: earliest.id,
                      driverName: earliest.driverName || null,
                      plateNumber: earliest.plateNumber || null,
                      truckCompany: earliest.truckCompany || null,
                      entryTime: toMillis(earliest.entryTime),
                  }
                : null,
            alternates: alternates.map((d) => ({
                id: d.id,
                driverName: d.driverName || null,
                plateNumber: d.plateNumber || null,
                truckCompany: d.truckCompany || null,
                entryTime: toMillis(d.entryTime),
            })),
        }
    });
});

exports.assignDriver = asyncWrapper(async (req, res) => {
    const body = assignDriverSchema.parse(req.body);
    const {dispatchKey, requestedDriverId, truckType, overrideTokenId, lineItems} = body;
    const assignedBy = req.user && req.user.uid;

    const result = await DB().runTransaction(async (tx) => {
        const assignRef = DB().collection(SAP_COLLECTION).doc(dispatchKey);
        const existing = await tx.get(assignRef);
        if (existing.exists) {
            return {status: 409, code: "DISPATCH_TAKEN", message: "This dispatch is already assigned."};
        }

        const queue = await loadQueueForType(truckType, tx);

        let requested = queue.find((d) => d.id === requestedDriverId);
        if (!requested) {
            requested = queue.find((d) => (d.driverId || "") === requestedDriverId);
        }
        if (!requested) {
            const directQueueDoc = await tx.get(DB().collection(QUEUE_COLLECTION).doc(requestedDriverId));
            if (directQueueDoc.exists) {
                requested = { id: directQueueDoc.id, ...directQueueDoc.data() };
            } else {
                const uidQueueSnap = await tx.get(
                    DB().collection(QUEUE_COLLECTION).where("driverId", "==", requestedDriverId).limit(1)
                );
                if (!uidQueueSnap.empty) {
                    requested = { id: uidQueueSnap.docs[0].id, ...uidQueueSnap.docs[0].data() };
                }
            }
        }
        if (!requested) {
            return {
                status: 409,
                code: "DRIVER_INACTIVE",
                message: "Requested driver is no longer in the queue.",
                meta: {requestedDriverId},
            };
        }

        if (!['waiting', 'available', 'assigned', 'loading', 'loaded', 'fully_loaded'].includes(requested.status)
            || String(requested.truckType || '').trim().toLowerCase() !== truckType.trim().toLowerCase()) {
            return {status: 409, code: 'DRIVER_INELIGIBLE', message: 'Queue entry is inactive or truck type does not match.'};
        }
        const driverIdForLookup = requested.driverId || requestedDriverId;
        const existingAssignmentsSnap = await tx.get(
            DB().collection(SAP_COLLECTION).where("driverId", "==", driverIdForLookup),
        );
        const inTransitLoads = existingAssignmentsSnap.docs
            .map((d) => d.data())
            .filter((a) => (a.tripStatus || "").toLowerCase() === "in_transit");

        if (inTransitLoads.length > 0 || requested.isFull === true) {
            const activeDispatchKeys = inTransitLoads.map((a) => a.dispatchKey || a.id || null);
            return {
                status: 409,
                code: "DRIVER_ON_ACTIVE_LOAD",
                message: requested.isFull === true
                    ? "Requested truck is already fully loaded."
                    : "Requested driver is already in transit (on the road). They cannot take another dispatch until the trip completes.",
                meta: {
                    requestedDriverId,
                    activeDispatchKeys,
                },
            };
        }

        const hasExistingPreTransit = existingAssignmentsSnap.docs
            .map((d) => d.data())
            .some((a) => ["assigned", "loading", "loaded", "fully_loaded"].includes((a.tripStatus || "").toLowerCase()));

        if (!hasExistingPreTransit) {
            const earliestCheck = validateEarliest(queue, truckType, requestedDriverId);
            if (earliestCheck && !overrideTokenId) {
                return {
                    status: 409,
                    code: "NOT_EARLIEST",
                    message: "Requested driver is not earliest in queue.",
                    meta: {
                        earliestDriverId: earliestCheck.meta.earliestDriverId,
                        requestedDriverId,
                    },
                };
            }
        }

        if (overrideTokenId) {
            const tokenResult = await tokenService.consumeInTransaction(tx, DB().collection("overrideTokens").doc(overrideTokenId), {
                consumedForAssignment: dispatchKey,
                requestedDriverId,
                consumedBy: assignedBy,
            });
            if (!tokenResult.ok) {
                return {
                    status: 403,
                    code: tokenResult.code,
                    message: tokenResult.message,
                    meta: {overrideTokenId},
                };
            }
        }

        const normalizedLineItems = lineItems.map((li) => {
            const q = typeof li.quantity === "string" ? parseFloat(li.quantity) : li.quantity;
            return {...li, quantity: Number.isFinite(q) ? q : null};
        });
        const driverAuthUid = requested.driverId || requestedDriverId;
        tx.set(assignRef, {
            driverId: driverAuthUid,
            queueId: requested.id,
            driverName: requested.driverName || null,
            truckPlate: requested.plateNumber || null,
            truckCompany: requested.truckCompany || null,
            truckType,
            lineItems: normalizedLineItems,
            assignedAt: admin.firestore.FieldValue.serverTimestamp(),
            assignedBy: assignedBy || null,
            overrideTokenId: overrideTokenId || null,
            tripStatus: "assigned",
        });

        const newAssignmentEntry = {
            dispatchKey,
            obdNumber: normalizedLineItems[0]?.obdNumber || dispatchKey,
            customerName: normalizedLineItems[0]?.customerName || "Customer",
            tripStatus: "assigned",
            assignedAt: new Date().toISOString(),
        };

        const existingAssignedList = Array.isArray(requested.assignedShipments) ? requested.assignedShipments : [];
        const updatedAssignedShipments = [...existingAssignedList, newAssignmentEntry];

        const queueRef = DB().collection(QUEUE_COLLECTION).doc(requested.id);
        tx.update(queueRef, {
            isAssigned: true,
            status: "loading",
            overallTripStatus: "loading",
            assignedShipment: dispatchKey,
            assignedShipments: updatedAssignedShipments,
            activeShipmentsCount: updatedAssignedShipments.length,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
            status: 200,
            data: {
                dispatchKey,
                driverId: requestedDriverId,
                usedOverride: !!overrideTokenId,
            },
        };
    });

    if (result.status >= 400) {
        return res.status(result.status).json({
            success: false,
            code: result.code,
            message: result.message,
            meta: result.meta,
        });
    }
    return res.json({success: true, data: result.data});
});

exports.requestOverride = asyncWrapper(async (req, res) => {
    const {dispatchKey, requestedDriverId, reason} = overrideRequestSchema.parse(req.body);
    const requestedBy = req.user && req.user.uid;

    const ref = DB().collection(OVERRIDE_REQUESTS).doc();
    await ref.set({
        dispatchKey,
        requestedDriverId,
        reason,
        requestedBy,
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "pending",
        decidedBy: null,
        decidedAt: null,
        decision: null,
        consumedAt: null,
    });
    return res.json({success: true, data: {requestId: ref.id}});
});

function sendDecision(res, result) {
    return res.status(result.status).json(result.status === 200
        ? {success: true, data: result.data} : {success: false, message: result.message});
}
exports.decideOverride = asyncWrapper(async (req, res) => {
    const input = overrideDecisionSchema.parse(req.body);
    return sendDecision(res, await decisions.decideOverride({...input, decidedBy: req.user.uid}));
});
exports.revokeOverride = asyncWrapper(async (req, res) => {
    const input = revokeSchema.parse(req.body);
    return sendDecision(res, await decisions.revoke(OVERRIDE_REQUESTS, {...input, uid: req.user.uid}));
});
exports.requestCancelAssignment = asyncWrapper(async (req, res) => {
    const input = cancelRequestSchema.parse(req.body);
    return sendDecision(res, await decisions.requestCancellation({...input, requestedBy: req.user.uid}));
});
exports.decideCancelAssignment = asyncWrapper(async (req, res) => {
    const input = cancelDecisionSchema.parse(req.body);
    return sendDecision(res, await decisions.decideCancellation({...input, decidedBy: req.user.uid}));
});
exports.revokeCancelAssignment = asyncWrapper(async (req, res) => {
    const input = revokeSchema.parse(req.body);
    return sendDecision(res, await decisions.revoke(CANCEL_REQUESTS, {...input, uid: req.user.uid}));
});
exports.getActiveDriverLocations = asyncWrapper(async (req, res) => {
    const snap = await DB()
        .collection(SAP_COLLECTION)
        .where("tripStatus", "in", ["assigned", "loading", "loaded", "fully_loaded", "in_transit"])
        .get();

    const results = [];
    for (const doc of snap.docs) {
        const data = doc.data();
        const ll = data.lastLocation;
        const lat = ll && typeof ll.lat === "number" && ll.lat !== 0 ? ll.lat : null;
        const lng = ll && typeof ll.lng === "number" && ll.lng !== 0 ? ll.lng : null;

        if (lat != null && lng != null) {
            results.push({
                dispatchKey: doc.id,
                driverId: data.driverId || null,
                driverName: data.driverName || null,
                truckPlate: data.truckPlate || null,
                tripStatus: data.tripStatus || null,
                lat,
                lng,
                at: ll && ll.at ? (ll.at.toMillis ? ll.at.toMillis() : null) : null,
            });
        }
    }

    return res.json({success: true, locations: results});
});
