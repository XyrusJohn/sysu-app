const test = require('node:test');
const assert = require('node:assert/strict');
const {safeReport, createSystemDiagnostics} = require('../../src/services/systemDiagnostics');

function fakeDb() {
    const rows = new Map();
    let sequence = 0;
    return {
        rows,
        collection(name) {
            assert.equal(name, 'system_error_logs');
            return {
                doc(id) {
                    const key = id || `event-${++sequence}`;
                    return {
                        id: key,
                        set: async value => rows.set(key, value),
                        get: async () => ({exists: rows.has(key), data: () => rows.get(key)}),
                        update: async value => rows.set(key, {...rows.get(key), ...value}),
                    };
                },
                orderBy() {
                    return {limit: () => ({get: async () => ({docs: [...rows].map(([id, value]) => ({id, data: () => value}))})})};
                },
            };
        },
    };
}

test('safeReport only retains allowlisted diagnostic metadata', () => {
    const result = safeReport({
        eventCode: 'mobile_operation_failure', operation: 'shipment-assignment', errorName: 'IOException',
        message: 'private customer data', stack: 'secret stack', details: {expectedCount: 4, secret: 'no'},
    });
    assert.equal(result.source, 'mobile');
    assert.equal(result.message, 'A mobile workflow operation failed.');
    assert.deepEqual(result.details, {expectedCount: 4});
    assert.equal('stack' in result, false);
    assert.equal('message' in result && result.message.includes('private'), false);
    assert.equal(safeReport({eventCode: 'unknown', stack: 'secret'}), null);
});

test('diagnostics are persisted, emitted to admin room, listed, and resolved', async () => {
    const db = fakeDb();
    const emitted = [];
    const io = {to: room => ({emit: (event, payload) => emitted.push({room, event, payload})})};
    const diagnostics = createSystemDiagnostics({db, io, clock: () => new Date('2026-10-21T00:00:00Z')});
    const created = await diagnostics.record({eventCode: 'sap_detail_mismatch', details: {expectedCount: 3, receivedCount: 2, missingCount: 1}});
    assert.equal(created.severity, 'warning');
    assert.equal((await diagnostics.list({openOnly: true})).length, 1);
    assert.equal(emitted[0].room, 'ops-admins');
    assert.equal(await diagnostics.resolve(created.id, 'admin-1'), true);
    assert.equal((await diagnostics.list({openOnly: true})).length, 0);
    assert.equal(emitted.at(-1).event, 'system_error_resolved');
});
