// sapAssignmentController — server-authoritative FIFO assignment.
//
// All writes to sap_assignments/{dispatchKey} and the relevant queue entry
// go through here. Direct client writes are blocked by Firestore rules.

const {admin} = require("../config/firebase.js");
const {resolveEarliest, validateEarliest} = require("../services/queueOrdering.js");
const tokenService = require("../services/tokenService.js");

const DB = () => admin.firestore();
const QUEUE_COLLECTION = "queue";
const SAP_COLLECTION = "sap_assignments";
const OVERRIDE_REQUESTS = "overrideRequests";
const CANCEL_REQUESTS = "cancelRequests";

// ── helpers ──────────────────────────────────────────────────────────────────

function bad(res, status, code, message, meta) {
    return res.status(status).json({
        success: false,
        code,
        message,
        meta: meta || undefined,
    });
}

function ok(res, data) {
    return res.json({success: true, data: data || {}});
}

// Mirror of the old client-side lineItems schema validation. The rules file
// used to enforce this; now the controller is the only writer, so the check
// lives here.
function validateLineItems(lineItems) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
        return "lineItems must be a non-empty array";
    }
    for (let i = 0; i < lineItems.length; i++) {
        const li = lineItems[i] || {};
        if (typeof li.obdNumber !== "string" || !li.obdNumber) {
            return `lineItems[${i}].obdNumber is required`;
        }
        // Quantity arrives as a string from the client (preserves SAP precision,
        // e.g. "20.000"). Accept string or number; reject anything that doesn't
        // parse to a finite number.
        let qtyNum;
        if (typeof li.quantity === "number") {
            qtyNum = li.quantity;
        } else if (typeof li.quantity === "string" && li.quantity.trim() !== "") {
            qtyNum = parseFloat(li.quantity);
        }
        if (!Number.isFinite(qtyNum)) {
            return `lineItems[${i}].quantity must be a number or numeric string`;
        }
        if (typeof li.customerName !== "string") {
            return `lineItems[${i}].customerName must be a string`;
        }
        if ("amount" in li) {
            return `lineItems[${i}].amount is forbidden`;
        }
    }
    return null;
}

function toMillis(value) {
    if (!value) return null;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (value instanceof Date) return value.getTime();
    if (typeof value === "object" && typeof value._seconds === "number") {
        return value._seconds * 1000;
    }
    return null;
}

async function isAdmin(uid) {
    if (!uid) return false;
    const snap = await DB().collection("users").doc(uid).get();
    const role = snap.data() && snap.data().role;
    return role === "admin" || role === "super_admin";
}

async function loadQueueForType(truckType) {
    // One read of the entire queue is fine — this is a single collection with
    // O(thousands) of docs at most and Firestore returns them in O(network).
    // If this becomes hot, add a composite index on truckType + entryTime.
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

// ── handlers ─────────────────────────────────────────────────────────────────

/**
 * GET /api/sap/peek?dispatchKey=X&truckType=Y
 *
 * Returns the earliest driver the dispatcher should assign, plus the rest of
 * the eligible queue in FIFO order so the modal can render disabled rows.
 */
exports.peekEarliest = async (req, res) => {
    try {
        const dispatchKey = (req.query.dispatchKey || "").toString().trim();
        const truckType = (req.query.truckType || "").toString().trim();
        if (!dispatchKey) {
            return bad(res, 400, "VALIDATION", "dispatchKey is required");
        }

        const queue = await loadQueueForType(truckType);
        const {earliest, alternates} = resolveEarliest(queue, truckType);

        return ok(res, {
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
        });
    } catch (err) {
        console.error("[sapAssignment] peekEarliest error:", err);
        return bad(res, 500, "INTERNAL", "Failed to read queue");
    }
};

/**
 * POST /api/sap/assign
 * body: { dispatchKey, requestedDriverId, truckType, driverSnapshot?, overrideTokenId? }
 *
 * Runs an atomic Firestore transaction. Two dispatchers racing on the same
 * dispatch will produce exactly one success and one 409.
 */
exports.assignDriver = async (req, res) => {
    const {dispatchKey, requestedDriverId, truckType, overrideTokenId, lineItems} = req.body || {};
    const driverSnapshot = req.body?.driverSnapshot || null;
    const assignedBy = req.user && req.user.uid;

    if (!dispatchKey || !requestedDriverId || !truckType) {
        return bad(res, 400, "VALIDATION", "dispatchKey, requestedDriverId, truckType required");
    }

    const lineErr = validateLineItems(lineItems);
    if (lineErr) {
        return bad(res, 400, "VALIDATION", lineErr);
    }

    try {
        const result = await DB().runTransaction(async (tx) => {
            const assignRef = DB().collection(SAP_COLLECTION).doc(dispatchKey);

            // Pre-check inside the transaction: dispatch must be unassigned
            // (or already assigned to this exact driver+token combo — but the
            // simpler model is "must not exist", which the rules layer enforces
            // for direct client writes).
            const existing = await tx.get(assignRef);
            if (existing.exists) {
                return {status: 409, code: "DISPATCH_TAKEN", message: "This dispatch is already assigned."};
            }

            const queue = await loadQueueForType(truckType);
            console.log(
                "[sapAssignment] assignDriver entry",
                "dispatchKey:", dispatchKey,
                "requestedDriverId:", requestedDriverId,
                "truckType:", truckType,
                "queueSize:", queue.length,
            );
            console.log(
                "[sapAssignment] FULL queue state:",
                queue.map((q, i) => ({
                    i,
                    id: q.id,
                    driverId: q.driverId || null,
                    driverName: q.driverName || null,
                    entryTime: q.entryTime,
                    isAssigned: q.isAssigned,
                    status: q.status,
                    truckType: q.truckType,
                })),
            );

            // Multi-shipment refers to multiple OBDs/line items per dispatch,
            // not multiple dispatches per driver. A driver on an active load
            // is BUSY and cannot be assigned another dispatch. We surface
            // this as DRIVER_INACTIVE rather than NOT_EARLIEST so the
            // dispatcher picks a different driver.
            //
            // The client may send EITHER:
            //   - the queue doc ID (Firestore auto-generated), OR
            //   - the driver's UID (Auth UID, stored in queue doc as `driverId`)
            // depending on which tab the dispatcher picked the driver from
            // (Queue tab → queue doc ID; Assigned tab → Auth UID).
            // We resolve both shapes here so the rest of the handler can
            // always work with the queue entry.
            let requested = queue.find((d) => d.id === requestedDriverId);
            if (!requested) {
                requested = queue.find((d) => (d.driverId || "") === requestedDriverId);
            }
            if (!requested) {
                console.warn(
                    "[sapAssignment] driver not found in queue for requestedDriverId:",
                    requestedDriverId,
                    "queueDocIds:",
                    queue.map((q) => q.id),
                    "queueDriverIds:",
                    queue.map((q) => q.driverId || null),
                );
                return {
                    status: 409,
                    code: "DRIVER_INACTIVE",
                    message: "Requested driver is no longer in the queue.",
                    meta: {requestedDriverId},
                };
            }
            
            // Multi-shipment check:
            // A driver may take additional dispatches (consolidated multi-drop OBDs)
            // as long as the truck is NOT FULL (isFull !== true) and NOT ON THE ROAD (tripStatus !== 'in_transit').
            // "in_transit" = TRUCK HAS LEFT THE WAREHOUSE -> BUSY (cannot take new dispatches).
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

            // If the driver already has active pre-transit assignments (consolidated load),
            // bypass NOT_EARLIEST check so dispatcher can add multiple OBDs to the same truck.
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

            // Now write the assignment and update the queue entry.
            // Coerce quantity to a number on the way in so the persisted
            // document has one canonical type regardless of what the client sent.
            const normalizedLineItems = (lineItems || []).map((li) => {
                const q = typeof li.quantity === "string" ? parseFloat(li.quantity) : li.quantity;
                return {...li, quantity: Number.isFinite(q) ? q : null};
            });
            // driverId semantics: queue docs carry BOTH a Firestore doc ID
            // (`id`) AND an auth UID (`driverId`). The assignment doc must
            // reference the auth UID — that is the actual driver — not the
            // queue entry doc ID. queueRef below is still keyed by the queue
            // doc ID, since that is how Firestore addresses the entry.
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
                // tripStatus lifecycle on the assignment doc:
                //   "assigned"    → just assigned, driver has not started loading
                //   "loading"     → driver is at the warehouse, getting OBDs onto the truck
                //   "loaded" → loading complete, ready to depart
                //   "in_transit"  → en route to delivery
                //   "completed"   → POD captured, delivery acknowledged
                // The dashboard filter and POD lookup read this field, so it must
                // exist on every assignment doc — starting at "assigned".
                tripStatus: "assigned",
            });

            // Build new assignment summary for queue document
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
        return ok(res, result.data);
    } catch (err) {
        console.error("[sapAssignment] assignDriver error:", err);
        return bad(res, 500, "INTERNAL", "Assignment failed.");
    }
};

/**
 * POST /api/sap/overrides/request
 * body: { dispatchKey, requestedDriverId, reason }
 *
 * Dispatcher asks an admin to approve a FIFO bypass. Writes a pending
 * overrideRequests doc.
 */
exports.requestOverride = async (req, res) => {
    const {dispatchKey, requestedDriverId, reason} = req.body || {};
    const requestedBy = req.user && req.user.uid;

    if (!dispatchKey || !requestedDriverId || !reason) {
        return bad(res, 400, "VALIDATION", "dispatchKey, requestedDriverId, reason required");
    }

    try {
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
        return ok(res, {requestId: ref.id});
    } catch (err) {
        console.error("[sapAssignment] requestOverride error:", err);
        return bad(res, 500, "INTERNAL", "Failed to create override request.");
    }
};

/**
 * POST /api/sap/overrides/decide
 * body: { requestId, decision: 'approved' | 'denied', reason? }
 *
 * Admin-only. On 'approved' the function issues a single-use token.
 */
exports.decideOverride = async (req, res) => {
    const {requestId, decision, reason} = req.body || {};
    const decidedBy = req.user && req.user.uid;

    if (!requestId || !decision || !["approved", "denied"].includes(decision)) {
        return bad(res, 400, "VALIDATION", "requestId and decision (approved|denied) required");
    }

    try {
        if (!(await isAdmin(decidedBy))) {
            return bad(res, 403, "FORBIDDEN", "Admin access required.");
        }

        const ref = DB().collection(OVERRIDE_REQUESTS).doc(requestId);
        const snap = await ref.get();
        if (!snap.exists) {
            return bad(res, 404, "NOT_FOUND", "Override request not found.");
        }
        const reqDoc = snap.data();
        if (reqDoc.status !== "pending") {
            return bad(res, 409, "ALREADY_DECIDED", `Request is already ${reqDoc.status}.`);
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

        return ok(res, {requestId, status: decision, tokenId, tokenExpiresAt: expiresAt});
    } catch (err) {
        console.error("[sapAssignment] decideOverride error:", err);
        return bad(res, 500, "INTERNAL", "Failed to decide override.");
    }
};

/**
 * POST /api/sap/overrides/revoke
 * body: { requestId }
 *
 * Dispatcher cancels their own pending request.
 */
exports.revokeOverride = async (req, res) => {
    const {requestId} = req.body || {};
    const uid = req.user && req.user.uid;
    if (!requestId) return bad(res, 400, "VALIDATION", "requestId required");

    try {
        const ref = DB().collection(OVERRIDE_REQUESTS).doc(requestId);
        const snap = await ref.get();
        if (!snap.exists) return bad(res, 404, "NOT_FOUND", "Override request not found.");
        const doc = snap.data();
        if (doc.requestedBy !== uid) {
            return bad(res, 403, "FORBIDDEN", "Cannot revoke another user's request.");
        }
        if (doc.status !== "pending") {
            return bad(res, 409, "ALREADY_DECIDED", `Request is already ${doc.status}.`);
        }
        await ref.update({
            status: "revoked",
            decidedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return ok(res, {requestId, status: "revoked"});
    } catch (err) {
        console.error("[sapAssignment] revokeOverride error:", err);
        return bad(res, 500, "INTERNAL", "Failed to revoke override.");
    }
};

/**
 * POST /api/sap/cancel/request
 * body: { dispatchKey, reason }
 *
 * Dispatcher asks an admin to approve a cancel. Writes a pending
 * cancelRequests doc. Mirrors requestOverride so the unified admin queue can
 * handle both action types the same way.
 */
exports.requestCancelAssignment = async (req, res) => {
    const {dispatchKey, reason} = req.body || {};
    const requestedBy = req.user && req.user.uid;

    if (!dispatchKey || !reason) {
        return bad(res, 400, "VALIDATION", "dispatchKey and reason required");
    }

    try {
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
        return ok(res, {requestId: ref.id});
    } catch (err) {
        console.error("[sapAssignment] requestCancelAssignment error:", err);
        return bad(res, 500, "INTERNAL", "Failed to create cancel request.");
    }
};

/**
 * POST /api/sap/cancel/decide
 * body: { requestId, decision: 'approved' | 'denied', reason? }
 *
 * Admin-only. On 'approved' the function runs the atomic reset (delete the
 * assignment + reset the queue entry + write cancelAudit). On 'denied' the
 * doc is just updated and the assignment stays in place.
 *
 * Mirrors decideOverride but without token issuance — the actual mutation
 * happens here, not via a separately-presented token.
 */
exports.decideCancelAssignment = async (req, res) => {
    const {requestId, decision, reason} = req.body || {};
    const decidedBy = req.user && req.user.uid;

    if (!requestId || !decision || !["approved", "denied"].includes(decision)) {
        return bad(res, 400, "VALIDATION", "requestId and decision (approved|denied) required");
    }

    try {
        if (!(await isAdmin(decidedBy))) {
            return bad(res, 403, "FORBIDDEN", "Admin access required.");
        }

        const ref = DB().collection(CANCEL_REQUESTS).doc(requestId);
        const snap = await ref.get();
        if (!snap.exists) {
            return bad(res, 404, "NOT_FOUND", "Cancel request not found.");
        }
        const reqDoc = snap.data();
        if (reqDoc.status !== "pending") {
            return bad(res, 409, "ALREADY_DECIDED", `Request is already ${reqDoc.status}.`);
        }

        if (decision === "denied") {
            await ref.update({
                status: "denied",
                decision,
                denyReason: reason || null,
                decidedBy,
                decidedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            return ok(res, {requestId, status: "denied"});
        }

        // Approved — run the atomic reset. The transaction reads the
        // assignment doc inside, so a concurrent cancel-decide on the same
        // dispatchKey is serialised by Firestore.
        const cancelAudit = await DB().runTransaction(async (tx) => {
            const assignRef = DB().collection(SAP_COLLECTION).doc(reqDoc.dispatchKey);
            const existing = await tx.get(assignRef);
            if (!existing.exists) {
                // The assignment was already gone (e.g. another admin raced
                // us). We still mark the request approved so the queue
                // clears, but the doc no longer exists.
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
                    assignedShipments: remainingShipments,
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
            // Stash the audit on the request itself so the admin queue can
            // show "applied at HH:MM" without a second Firestore read.
            cancelAudit: cancelAudit || null,
        });

        return ok(res, {requestId, status: "approved"});
    } catch (err) {
        console.error("[sapAssignment] decideCancelAssignment error:", err);
        return bad(res, 500, "INTERNAL", "Failed to decide cancel.");
    }
};

/**
 * POST /api/sap/cancel/revoke
 * body: { requestId }
 *
 * Dispatcher cancels their own pending cancel request. Mirrors
 * revokeOverride.
 */
exports.revokeCancelAssignment = async (req, res) => {
    const {requestId} = req.body || {};
    const uid = req.user && req.user.uid;
    if (!requestId) return bad(res, 400, "VALIDATION", "requestId required");

    try {
        const ref = DB().collection(CANCEL_REQUESTS).doc(requestId);
        const snap = await ref.get();
        if (!snap.exists) return bad(res, 404, "NOT_FOUND", "Cancel request not found.");
        const doc = snap.data();
        if (doc.requestedBy !== uid) {
            return bad(res, 403, "FORBIDDEN", "Cannot revoke another user's request.");
        }
        if (doc.status !== "pending") {
            return bad(res, 409, "ALREADY_DECIDED", `Request is already ${doc.status}.`);
        }
        await ref.update({
            status: "revoked",
            decidedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return ok(res, {requestId, status: "revoked"});
    } catch (err) {
        console.error("[sapAssignment] revokeCancelAssignment error:", err);
        return bad(res, 500, "INTERNAL", "Failed to revoke cancel.");
    }
};

// GET /api/sap/locations
//
// Returns the last persisted location for every dispatch whose tripStatus
// is in `["loading", "loaded", "in_transit"]`. Each entry has the shape:
//   { dispatchKey, driverId, driverName, truckPlate, lat, lng, at, tripStatus }
//
// `lat` and `lng` are 0/null if the driver has never reported a position
// for that dispatch — call sites should skip those.
//
// Used by the dispatcher dashboard on initial load so that markers appear
// immediately, even before any live `driver_moving` event arrives from the
// driver app.
exports.getActiveDriverLocations = async (req, res) => {
    try {
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

            // Only return to map seeder if it has actual GPS coordinates
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

        return ok(res, {locations: results});
    } catch (err) {
        console.error("[sapAssignment] getActiveDriverLocations error:", err);
        return bad(res, 500, "INTERNAL", "Failed to load driver locations.");
    }
};

