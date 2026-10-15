// sapAssignmentController — server-authoritative FIFO assignment.
//
// All writes to sap_assignments/{dispatchKey} and the relevant queue entry
// go through here. Direct client writes are blocked by Firestore rules.

const {admin} = require("../config/firebase.js");
const {resolveEarliest, validateEarliest} = require("../services/queueOrdering.js");
const tokenService = require("../services/tokenService.js");
const {asyncWrapper} = require("../middleware/asyncWrapper.js");
const { z } = require("zod");

const DB = () => admin.firestore();
const QUEUE_COLLECTION = "queue";
const SAP_COLLECTION = "sap_assignments";
const OVERRIDE_REQUESTS = "overrideRequests";
const CANCEL_REQUESTS = "cancelRequests";

// ── Validation Schemas ─────────────────────────────────────────────────────────────

const lineItemSchema = z.object({
    obdNumber: z.string().min(1),
    quantity: z.union([z.number(), z.string().regex(/^\\d+(\\.\\d+)?$/)]),
    customerName: z.string().min(1),
    amount: z.undefined().optional(), // Explicitly forbid amount
});

const assignDriverSchema = z.object({
    dispatchKey: z.string().min(1),
    requestedDriverId: z.string().min(1),
    truckType: z.string().min(1),
    overrideTokenId: z.string().optional(),
    driverSnapshot: z.any().optional(),
    lineItems: z.array(lineItemSchema).min(1),
});

const overrideRequestSchema = z.object({
    dispatchKey: z.string().min(1),
    requestedDriverId: z.string().min(1),
    reason: z.string().min(1),
});

const overrideDecisionSchema = z.object({
    requestId: z.string().min(1),
    decision: z.enum(["approved", "denied"]),
    reason: z.string().optional(),
});

const cancelRequestSchema = z.object({
    dispatchKey: z.string().min(1),
    reason: z.string().min(1),
});

const cancelDecisionSchema = z.object({
    requestId: z.string().min(1),
    decision: z.enum(["approved", "denied"]),
    reason: z.string().optional(),
});

const revokeSchema = z.object({
    requestId: z.string().min(1),
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

async function loadQueueForType(truckType) {
    const snap = await DB().collection(QUEUE_COLLECTION).get();
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
    const driverSnapshot = req.body?.driverSnapshot || null;
    const assignedBy = req.user && req.user.uid;

    const result = await DB().runTransaction(async (tx) => {
        const assignRef = DB().collection(SAP_COLLECTION).doc(dispatchKey);
        const existing = await tx.get(assignRef);
        if (existing.exists) {
            return {status: 409, code: "DISPATCH_TAKEN", message: "This dispatch is already assigned."};
        }

        const queue = await loadQueueForType(truckType);

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
            const tokenResult = await tokenService.consumeTokenInTransaction(tx, overrideTokenId, {
                dispatchKey,
                driverId: requestedDriverId,
                usedBy: assignedBy,
            });
            if (!tokenResult.valid) {
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
            driverName: driverSnapshot?.driverName || requested.driverName || null,
            truckPlate: driverSnapshot?.truckPlate || requested.plateNumber || null,
            truckCompany: driverSnapshot?.truckCompany || requested.truckCompany || null,
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

exports.decideOverride = asyncWrapper(async (req, res) => {
    const {requestId, decision, reason} = overrideDecisionSchema.parse(req.body);
    const decidedBy = req.user && req.user.uid;

    const ref = DB().collection(OVERRIDE_REQUESTS).doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) {
        return res.status(404).json({success: false, message: "Override request not found."});
    }
    const reqDoc = snap.data();
    if (reqDoc.status !== "pending") {
        return res.status(409).json({success: false, message: `Request is already ${reqDoc.status}.`});
    }

    let tokenId = null;
    let expiresAt = null;

    if (decision === "approved") {
        const issued = await tokenService.issue({
            dispatchKey: reqDoc.dispatchKey,
            requestedDriverId: reqDoc.requestedDriverId,
            reason: reqDoc.reason,
            requestId,
            issuedBy: decidedBy,
        });
        tokenId = issued.tokenId;
        expiresAt = issued.expiresAt.toISOString();
    }

    await ref.update({
        status: decision,
        decision,
        decidedBy,
        decidedAt: admin.firestore.FieldValue.serverTimestamp(),
        denyReason: decision === "denied" ? reason || null : null,
        tokenId: tokenId || null,
        tokenExpiresAt: expiresAt,
    });

    return res.json({success: true, data: {requestId, status: decision, tokenId, tokenExpiresAt: expiresAt}});
});

exports.revokeOverride = asyncWrapper(async (req, res) => {
    const {requestId} = revokeSchema.parse(req.body);
    const uid = req.user && req.user.uid;

    const ref = DB().collection(OVERRIDE_REQUESTS).doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({success: false, message: "Override request not found."});
    const doc = snap.data();
    if (doc.requestedBy !== uid) {
        return res.status(403).json({success: false, message: "Cannot revoke another user's request."});
    }
    if (doc.status !== "pending") {
        return res.status(409).json({success: false, message: `Request is already ${doc.status}.`});
    }
    await ref.update({
        status: "revoked",
        decidedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({success: true, data: {requestId, status: "revoked"}});
});

exports.requestCancelAssignment = asyncWrapper(async (req, res) => {
    const {dispatchKey, reason} = cancelRequestSchema.parse(req.body);
    const requestedBy = req.user && req.user.uid;

    const ref = DB().collection(CANCEL_REQUESTS).doc();
    await ref.set({
        dispatchKey,
        reason,
        requestedBy,
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "pending",
        action: "cancel",
        decidedBy: null,
        decidedAt: null,
        decision: null,
        cancelAudit: null,
    });
    return res.json({success: true, data: {requestId: ref.id}});
});

exports.decideCancelAssignment = asyncWrapper(async (req, res) => {
    const {requestId, decision, reason} = cancelDecisionSchema.parse(req.body);
    const decidedBy = req.user && req.user.uid;

    const ref = DB().collection(CANCEL_REQUESTS).doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) {
        return res.status(404).json({success: false, message: "Cancel request not found."});
    }
    const reqDoc = snap.data();
    if (reqDoc.status !== "pending") {
        return res.status(409).json({success: false, message: `Request is already ${reqDoc.status}.`});
    }

    if (decision === "denied") {
        await ref.update({
            status: "denied",
            decision,
            denyReason: reason || null,
            decidedBy,
            decidedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return res.json({success: true, data: {requestId, status: "denied"}});
    }

    const cancelAudit = await DB().runTransaction(async (tx) => {
        const assignRef = DB().collection(SAP_COLLECTION).doc(reqDoc.dispatchKey);
        const existing = await tx.get(assignRef);
        if (!existing.exists) {
            return null;
        }
        const asgn = existing.data();
        const queueSnap = await tx.get(
            DB().collection(QUEUE_COLLECTION).where("driverId", "==", asgn.driverId).limit(1),
        );
        const queueDoc = queueSnap.docs[0];

        tx.delete(assignRef);

        const audit = {
            reason: reqDoc.reason,
            cancelledBy: decidedBy,
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            dispatchKey: reqDoc.dispatchKey,
        };

        if (queueDoc) {
            const qData = queueDoc.data() || {};
            const currentList = Array.isArray(qData.assignedShipments) ? qData.assignedShipments : [];
            const remainingShipments = currentList.filter(
                (s) => (s.dispatchKey || s.id || s.obdNumber) !== reqDoc.dispatchKey
            );
            const hasRemaining = remainingShipments.length > 0;

            tx.update(queueDoc.ref, {
                assignedShipments: remainingHShipments,
                activeShipmentsCount: remainingShipments.length,
                isAssigned: hasRemaining,
                status: hasRemaining ? (qData.status || "loading") : "available",
                overallTripStatus: hasRemaining ? (qData.overallTripStatus || "loading") : "available",
                assignedShipment: hasRemaining ? remainingShipments[0].dispatchKey : null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                cancelAudit: audit,
            });
        }

        return audit;
    });

    await ref.update({
        status: "approved",
        decision,
        decidedBy,
        decidedAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelAudit: cancelAudit || null,
    });

    return res.json({success: true, data: {requestId, status: "approved"}});
});

exports.revokeCancelAssignment = asyncWrapper(async (req, res) => {
    const {requestId} = revokeSchema.parse(req.body);
    const uid = req.user && req.user.uid;

    const ref = DB().collection(CANCEL_REQUESTS).doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({success: false, message: "Override request not found."});
    const doc = snap.data();
    if (doc.requestedBy !== uid) {
        return res.status(403).json({success: false, message: "Cannot revoke another user's request."});
    }
    if (doc.status !== "pending") {
        return res.status(409).json({success: false, message: `Request is already ${doc.status}.`});
    }
    await ref.update({
    status: "revoked",
    decidedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({success: true, data: {requestId, status: "revoked"}});
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
