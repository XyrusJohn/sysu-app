const fs = require('fs');

// ── 1. Backend controller: cancelAssignment ─────────────────────────────────
const ctrlPath = 'backend/src/controllers/sapAssignmentController.js';
let ctrl = fs.readFileSync(ctrlPath, 'utf8');

const CTRL_FOOTER =
    '        return bad(res, 500, "INTERNAL", "Failed to revoke override.");\n' +
    '    }\n' +
    '};\n';

const NEW_CTRL =
    '        return bad(res, 500, "INTERNAL", "Failed to revoke override.");\n' +
    '    }\n' +
    '};\n' +
    '\n' +
    '/**\n' +
    ' * POST /api/sap/cancel\n' +
    ' * body: { dispatchKey, reason }\n' +
    ' *\n' +
    ' * Cancels an existing assignment: deletes sap_assignments/{dispatchKey} and\n' +
    ' * resets the relevant queue entry back to its pre-assignment state\n' +
    ' * (isAssigned=false, status=available, assignedShipment=null). The cancel\n' +
    ' * is recorded as an `audit` subfield on the queue entry so dispatchers can\n' +
    ' * see why the assignment was rolled back.\n' +
    ' *\n' +
    ' * Runs in an atomic Firestore transaction so a concurrent dispatcher\n' +
    ' * clicking Assign on the same dispatch cannot interleave with the cancel.\n' +
    ' */\n' +
    'exports.cancelAssignment = async (req, res) => {\n' +
    '    const {dispatchKey, reason} = req.body || {};\n' +
    '    const cancelledBy = req.user && req.user.uid;\n' +
    '\n' +
    '    if (!dispatchKey || !reason) {\n' +
    '        return bad(res, 400, "VALIDATION", "dispatchKey and reason required");\n' +
    '    }\n' +
    '\n' +
    '    try {\n' +
    '        const result = await DB().runTransaction(async (tx) => {\n' +
    '            const assignRef = DB().collection(SAP_COLLECTION).doc(dispatchKey);\n' +
    '            const existing = await tx.get(assignRef);\n' +
    '            if (!existing.exists) {\n' +
    '                return {\n' +
    '                    status: 409,\n' +
    '                    code: "NOT_ASSIGNED",\n' +
    '                    message: "This dispatch is not currently assigned.",\n' +
    '                };\n' +
    '            }\n' +
    '            const asgn = existing.data();\n' +
    '            // The queue entry is keyed by its Firestore doc ID, which is\n' +
    '            // whatever we stored in `requested` during assign — but the\n' +
    '            // assignment doc only stored the auth UID in driverId, so we\n' +
    '            // need to look the queue entry up by the driverId.\n' +
    '            const queueSnap = await tx.get(\n' +
    '                DB().collection(QUEUE_COLLECTION).where("driverId", "==", asgn.driverId).limit(1),\n' +
    '            );\n' +
    '            const queueDoc = queueSnap.docs[0];\n' +
    '\n' +
    '            tx.delete(assignRef);\n' +
    '\n' +
    '            if (queueDoc) {\n' +
    '                tx.update(queueDoc.ref, {\n' +
    '                    isAssigned: false,\n' +
    '                    status: "available",\n' +
    '                    assignedShipment: null,\n' +
    '                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),\n' +
    '                    cancelAudit: {\n' +
    '                        reason,\n' +
    '                        cancelledBy: cancelledBy || null,\n' +
    '                        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),\n' +
    '                        dispatchKey,\n' +
    '                    },\n' +
    '                });\n' +
    '            }\n' +
    '\n' +
    '            return {status: 200, data: {dispatchKey, cancelled: true}};\n' +
    '        });\n' +
    '\n' +
    '        if (result.status >= 400) {\n' +
    '            return res.status(result.status).json({\n' +
    '                success: false,\n' +
    '                code: result.code,\n' +
    '                message: result.message,\n' +
    '            });\n' +
    '        }\n' +
    '        return ok(res, result.data);\n' +
    '    } catch (err) {\n' +
    '        console.error("[sapAssignment] cancelAssignment error:", err);\n' +
    '        return bad(res, 500, "INTERNAL", "Cancel failed.");\n' +
    '    }\n' +
    '};\n';

const c1 = ctrl.split(CTRL_FOOTER).length - 1;
console.log('controller footer matches:', c1);
if (c1 !== 1) { console.error('expected 1, got', c1); process.exit(1); }
ctrl = ctrl.replace(CTRL_FOOTER, NEW_CTRL);
fs.writeFileSync(ctrlPath, ctrl, 'utf8');

// ── 2. Backend route: /api/sap/cancel ──────────────────────────────────────
const routePath = 'backend/src/routes/sapAssignmentRoute.js';
let route = fs.readFileSync(routePath, 'utf8');

const ROUTE_FOOTER =
    '// Dispatcher cancels their own pending bypass request.\n' +
    'router.post("/overrides/revoke", ctrl.revokeOverride);\n' +
    '\n' +
    'module.exports = router;\n';

const NEW_ROUTE =
    '// Dispatcher cancels their own pending bypass request.\n' +
    'router.post("/overrides/revoke", ctrl.revokeOverride);\n' +
    '\n' +
    '// Dispatcher cancels an already-confirmed assignment.\n' +
    'router.post("/cancel", ctrl.cancelAssignment);\n' +
    '\n' +
    'module.exports = router;\n';

const c2 = route.split(ROUTE_FOOTER).length - 1;
console.log('route footer matches:', c2);
if (c2 !== 1) { console.error('expected 1, got', c2); process.exit(1); }
route = route.replace(ROUTE_FOOTER, NEW_ROUTE);
fs.writeFileSync(routePath, route, 'utf8');

console.log('backend done');
