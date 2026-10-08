// Override-token service. Tokens grant a one-shot ability to assign a
// non-earliest driver. Lifecycle is server-authoritative.
//
// Storage shape (collection `overrideTokens`):
//   {
//     tokenId,                // doc id
//     dispatchKey,
//     requestedDriverId,
//     reason,
//     requestId,              // FK to overrideRequests/{id}
//     issuedBy,               // admin UID
//     issuedAt,               // server timestamp
//     expiresAt,              // server timestamp (issuedAt + TTL_MS)
//     consumedAt,             // server timestamp | null
//     consumedBy,             // uid | null
//     consumedForAssignment,  // assignment doc id | null
//   }

const {admin} = require("../config/firebase.js");

const COLLECTION = "overrideTokens";

// Production DB resolver. Tests can override this module via Node's require
// cache to inject a fake. Default reads admin.firestore() lazily so the module
// can be imported without an initialized Firebase app.
let _dbGetter = () => admin.firestore();

function setDbGetter(fn) {
    _dbGetter = fn;
}

function DB() {
    return _dbGetter();
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * Issue a single-use override token.
 *
 * @param {{
 *   dispatchKey: string,
 *   requestedDriverId: string,
 *   reason: string,
 *   requestId: string,
 *   issuedBy: string,        // admin UID
 *   ttlMs?: number,          // default 15 minutes
 * }} input
 * @returns {Promise<{ tokenId: string, expiresAt: Date }>}
 */
async function issue(input, transaction) {
    if (!input || !input.dispatchKey || !input.requestedDriverId) {
        throw new Error("issue: dispatchKey and requestedDriverId are required");
    }
    if (!input.issuedBy) {
        throw new Error("issue: issuedBy is required");
    }

    const ttl = Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL_MS;
    const now = Date.now();
    const expiresAtMs = now + ttl;

    const ref = DB().collection(COLLECTION).doc();
    const data = {
        dispatchKey: input.dispatchKey,
        requestedDriverId: input.requestedDriverId,
        reason: input.reason || null,
        requestId: input.requestId || null,
        issuedBy: input.issuedBy,
        issuedAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(expiresAtMs),
        consumedAt: null,
        consumedBy: null,
        consumedForAssignment: null,
    };
    if (transaction) transaction.set(ref, data);
    else await ref.set(data);

    return {tokenId: ref.id, expiresAt: new Date(expiresAtMs)};
}

/**
 * Verify (read-only) that a token is currently valid for a given assignment.
 *
 * Returns:
 *   { ok: true, token }
 *   { ok: false, code: 'TOKEN_NOT_FOUND' | 'TOKEN_CONSUMED' | 'TOKEN_EXPIRED' |
 *                     'TOKEN_DISPATCH_MISMATCH' | 'TOKEN_DRIVER_MISMATCH',
 *     token?: object }
 */
async function verify(tokenId, {dispatchKey, requestedDriverId}) {
    if (!tokenId) return {ok: false, code: "TOKEN_NOT_FOUND"};

    const snap = await DB().collection(COLLECTION).doc(tokenId).get();
    if (!snap.exists) return {ok: false, code: "TOKEN_NOT_FOUND"};

    const token = snap.data();
    if (token.consumedAt) {
        return {ok: false, code: "TOKEN_CONSUMED", token};
    }
    if (isExpired(token)) {
        return {ok: false, code: "TOKEN_EXPIRED", token};
    }
    if (dispatchKey && token.dispatchKey !== dispatchKey) {
        return {ok: false, code: "TOKEN_DISPATCH_MISMATCH", token};
    }
    if (requestedDriverId && token.requestedDriverId !== requestedDriverId) {
        return {ok: false, code: "TOKEN_DRIVER_MISMATCH", token};
    }
    return {ok: true, token};
}

function isExpired(token) {
    if (!token || !token.expiresAt) return true;
    const ms = token.expiresAt.toMillis ? token.expiresAt.toMillis() : null;
    if (ms == null) return true;
    return ms <= Date.now();
}

/**
 * Atomically mark a token as consumed, but only if it has not been consumed
 * and has not expired. Returns the same shape as verify() with ok=false on
 * conflict so the caller can map it to the right HTTP code.
 *
 * Must be called inside the same Firestore transaction that performs the
 * assignment write — otherwise two concurrent consumes could both succeed.
 *
 * Pass the Firestore transaction via `transaction` and the token doc
 * reference via `tokenRef`.
 */
async function consumeInTransaction(transaction, tokenRef, {consumedBy, consumedForAssignment, requestedDriverId}) {
    const snap = await transaction.get(tokenRef);
    if (!snap.exists) {
        return {ok: false, code: "TOKEN_NOT_FOUND"};
    }
    const token = snap.data();
    if (token.consumedAt) {
        return {ok: false, code: "TOKEN_CONSUMED", token};
    }
    if (isExpired(token)) {
        return {ok: false, code: "TOKEN_EXPIRED", token};
    }
    if (token.dispatchKey !== consumedForAssignment) {
        return {ok: false, code: "TOKEN_DISPATCH_MISMATCH"};
    }
    if (token.requestedDriverId !== requestedDriverId) {
        return {ok: false, code: "TOKEN_DRIVER_MISMATCH"};
    }
    if (!consumedBy) return {ok: false, code: "TOKEN_ACTOR_REQUIRED"};
    transaction.update(tokenRef, {
        consumedAt: admin.firestore.FieldValue.serverTimestamp(),
        consumedBy: consumedBy || null,
        consumedForAssignment: consumedForAssignment || null,
    });
    return {ok: true, token};
}

module.exports = {issue, verify, consumeInTransaction, isExpired, DEFAULT_TTL_MS, setDbGetter};
