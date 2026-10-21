const EVENT_CODES = new Set([
    'api_request_failure',
    'frontend_uncaught',
    'frontend_unhandled_rejection',
    'frontend_operation_failure',
    'mobile_uncaught_exception',
    'mobile_operation_failure',
    'sap_unavailable',
    'sap_detail_mismatch',
]);

const MESSAGES = Object.freeze({
    api_request_failure: 'A server request failed.',
    frontend_uncaught: 'A browser operation failed unexpectedly.',
    frontend_unhandled_rejection: 'A browser background operation failed.',
    frontend_operation_failure: 'A browser workflow operation failed.',
    mobile_uncaught_exception: 'The mobile app terminated unexpectedly.',
    mobile_operation_failure: 'A mobile workflow operation failed.',
    sap_unavailable: 'The SAP integration could not complete a request.',
    sap_detail_mismatch: 'SAP returned fewer dispatch details than the assigned records require.',
});

function safeReport(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !EVENT_CODES.has(input.eventCode)) return null;
    const operation = typeof input.operation === 'string' && /^[a-z][a-z0-9_-]{0,47}$/.test(input.operation)
        ? input.operation : null;
    const errorName = typeof input.errorName === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(input.errorName)
        ? input.errorName : null;
    const requestId = typeof input.requestId === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(input.requestId)
        ? input.requestId : null;
    const route = typeof input.route === 'string' && input.route.startsWith('/')
        && input.route.length <= 120 && !/[?#]/.test(input.route) ? input.route : null;
    const actorId = typeof input.actorId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.actorId)
        ? input.actorId : null;
    const details = input.details && typeof input.details === 'object' && !Array.isArray(input.details)
        ? Object.fromEntries(['expectedCount', 'receivedCount', 'missingCount', 'statusCode']
            .filter(key => Number.isInteger(input.details[key]) && input.details[key] >= 0
                && (key !== 'statusCode' || (input.details[key] >= 500 && input.details[key] <= 599)))
            .map(key => [key, Math.min(input.details[key], 100000)]))
        : {};
    return {
        eventCode: input.eventCode,
        source: input.eventCode.startsWith('frontend_') ? 'web'
            : input.eventCode.startsWith('mobile_') ? 'mobile'
                : input.eventCode.startsWith('sap_') ? 'sap' : 'backend',
        severity: input.eventCode === 'sap_detail_mismatch' ? 'warning' : 'error',
        message: MESSAGES[input.eventCode],
        operation,
        errorName,
        requestId,
        route,
        actorId,
        details,
    };
}

function createSystemDiagnostics({db, io, clock = () => new Date()}) {
    async function record(input) {
        const report = safeReport(input);
        if (!report) return null;
        const createdAt = clock();
        const ref = db.collection('system_error_logs').doc();
        const data = {...report, createdAt, resolvedAt: null, resolvedBy: null};
        await ref.set(data);
        io?.to('ops-admins').emit('system_error_created', {id: ref.id, ...data});
        return {id: ref.id, ...data};
    }

    async function list({limit = 50, openOnly = true} = {}) {
        const size = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
        const snapshot = await db.collection('system_error_logs').orderBy('createdAt', 'desc').limit(size).get();
        const items = snapshot.docs.map(doc => ({id: doc.id, ...doc.data()}));
        return openOnly ? items.filter(item => !item.resolvedAt) : items;
    }

    async function resolve(id, actorId) {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return false;
        const ref = db.collection('system_error_logs').doc(id);
        const snapshot = await ref.get();
        if (!snapshot.exists) return false;
        const resolvedAt = clock();
        await ref.update({resolvedAt, resolvedBy: actorId});
        io?.to('ops-admins').emit('system_error_resolved', {id, resolvedAt});
        return true;
    }

    return {record, list, resolve};
}

module.exports = {EVENT_CODES, safeReport, createSystemDiagnostics};
