const {z} = require('zod');
const {admin} = require('../config/firebase');
const {createSystemDiagnostics} = require('../services/systemDiagnostics');

const reportSchema = z.object({
    eventCode: z.enum([
        'frontend_uncaught', 'frontend_unhandled_rejection', 'frontend_operation_failure',
        'mobile_uncaught_exception', 'mobile_operation_failure',
    ]),
    operation: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/).optional(),
    errorName: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,79}$/).optional(),
}).strict();

function service() {
    return createSystemDiagnostics({db: admin.firestore(), io: global._io});
}

async function reportClientError(req, res) {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({success: false, error: 'Invalid diagnostic report'});
    try {
        const record = await service().record({...parsed.data, requestId: req.requestId, actorId: req.user.uid});
        return res.status(202).json({success: true, id: record.id});
    } catch {
        console.error(JSON.stringify({event: 'diagnostic_report_persist_failed', requestId: req.requestId}));
        return res.status(503).json({success: false, requestId: req.requestId, error: 'Diagnostic report could not be saved'});
    }
}

async function listSystemErrors(req, res) {
    try {
        const limit = Number(req.query.limit || 50);
        const openOnly = req.query.openOnly !== 'false';
        const items = await service().list({limit, openOnly});
        return res.json({success: true, items});
    } catch {
        console.error(JSON.stringify({event: 'diagnostic_report_list_failed', requestId: req.requestId}));
        return res.status(503).json({success: false, requestId: req.requestId, error: 'System logs are temporarily unavailable'});
    }
}

async function resolveSystemError(req, res) {
    try {
        const found = await service().resolve(req.params.id, req.user.uid);
        if (!found) return res.status(404).json({success: false, error: 'System log not found'});
        return res.json({success: true});
    } catch {
        console.error(JSON.stringify({event: 'diagnostic_report_resolve_failed', requestId: req.requestId}));
        return res.status(503).json({success: false, requestId: req.requestId, error: 'System log could not be updated'});
    }
}

module.exports = {reportClientError, listSystemErrors, resolveSystemError};
