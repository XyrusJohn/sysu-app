// Frontend service for the server-authoritative FIFO assignment flow.
//
// The browser no longer writes sap_assignments or queue.status directly.
// Every assignment goes through /api/sap/assign; the server runs the
// FIFO transaction and (when needed) verifies + consumes an override token.

import {API_CONFIG} from "./config.js";
import {AuthService} from "./authService.js";

async function handle(res) {
    let body;
    try {
        body = await res.json();
    } catch {
        body = null;
    }
    if (!res.ok || (body && body.success === false)) {
        const err = new Error((body && body.message) || `HTTP ${res.status}`);
        err.code = (body && body.code) || "HTTP_" + res.status;
        err.meta = (body && body.meta) || null;
        err.status = res.status;
        throw err;
    }
    return body && Object.prototype.hasOwnProperty.call(body, "data") ? body.data : body;
}

async function request(url, options = {}) {
    const timeoutSignal = AbortSignal.timeout(30_000);
    let rejectOnTimeout;
    const timeoutPromise = new Promise((_, reject) => {
        rejectOnTimeout = () => reject(timeoutSignal.reason || new Error("Request timed out"));
        timeoutSignal.addEventListener("abort", rejectOnTimeout, {once: true});
    });
    try {
        const token = await Promise.race([AuthService.getToken(), timeoutPromise]);
        if (timeoutSignal.aborted) throw timeoutSignal.reason;
        const response = await fetch(url, {
            ...options,
            signal: timeoutSignal,
            headers: {
                "Content-Type": "application/json",
                ...(options.headers || {}),
                Authorization: `Bearer ${token}`,
            },
        });
        return await handle(response);
    } catch (error) {
        if (timeoutSignal.aborted) {
            throw new Error("Request timed out. Check the latest system status before retrying.");
        }
        throw error;
    } finally {
        timeoutSignal.removeEventListener("abort", rejectOnTimeout);
    }
}

export const SAPAssignmentService = {
    /**
     * Ask the server which driver is earliest in the queue for a dispatch.
     * The modal uses this to render one enabled row + disabled alternates.
     */
    async peekEarliest(dispatchKey, truckType) {
        const params = new URLSearchParams({dispatchKey});
        if (truckType) params.set("truckType", truckType);
        return request(`${API_CONFIG.BASE_URL}/api/sap/peek?${params.toString()}`, {method: "GET"});
    },

    /**
     * Authoritative assignment write.
     *
     * @param {object} input
     * @param {string} input.dispatchKey
     * @param {string} input.requestedDriverId
     * @param {string} input.truckType
     * @param {Array}   input.lineItems         - validated server-side
     * @param {object}  [input.driverSnapshot]  - { driverName, truckPlate, truckCompany }
     * @param {string}  [input.overrideTokenId] - if breaking FIFO with admin approval
     */
    async assignDriver({
        dispatchKey,
        requestedDriverId,
        truckType,
        lineItems,
        driverSnapshot,
        overrideTokenId,
    }) {
        const body = {
            dispatchKey,
            requestedDriverId,
            truckType,
            lineItems: lineItems || [],
            driverSnapshot: driverSnapshot || null,
            overrideTokenId: overrideTokenId || null,
        };
        return request(`${API_CONFIG.BASE_URL}/api/sap/assign`, {
            method: "POST",
            body: JSON.stringify(body),
        });
    },

    /**
     * Dispatcher requests a FIFO bypass.
     * @returns {Promise<{requestId: string}>}
     */
    async requestOverride({dispatchKey, requestedDriverId, reason}) {
        return request(`${API_CONFIG.BASE_URL}/api/sap/overrides/request`, {
            method: "POST",
            body: JSON.stringify({dispatchKey, requestedDriverId, reason}),
        });
    },

    /**
     * Admin approves or denies a pending override request.
     */
    async decideOverride({requestId, decision, reason}) {
        return request(`${API_CONFIG.BASE_URL}/api/sap/overrides/decide`, {
            method: "POST",
            body: JSON.stringify({requestId, decision, reason}),
        });
    },

    /**
     * Dispatcher cancels their own pending override request.
     */
    async revokeOverride(requestId) {
        return request(`${API_CONFIG.BASE_URL}/api/sap/overrides/revoke`, {
            method: "POST",
            body: JSON.stringify({requestId}),
        });
    },

    /**
     * Dispatcher requests admin approval to cancel an already-confirmed
     * assignment. Mirrors requestOverride: server writes a pending
     * cancelRequests doc; admin approves or denies from the unified queue.
     */
    async requestCancel({dispatchKey, reason}) {
        return request(`${API_CONFIG.BASE_URL}/api/sap/cancel/request`, {
            method: "POST",
            body: JSON.stringify({dispatchKey, reason}),
        });
    },

    /**
     * Admin approves or denies a pending cancel request.
     */
    async decideCancel({requestId, decision, reason}) {
        return request(`${API_CONFIG.BASE_URL}/api/sap/cancel/decide`, {
            method: "POST",
            body: JSON.stringify({requestId, decision, reason}),
        });
    },

    /**
     * Dispatcher revokes their own pending cancel request.
     */
    async revokeCancel(requestId) {
        return request(`${API_CONFIG.BASE_URL}/api/sap/cancel/revoke`, {
            method: "POST",
            body: JSON.stringify({requestId}),
        });
    },

    /**
     * Fetch the last persisted location for every in-flight dispatch
     * (loading / loaded / in_transit). Used by the dispatcher dashboard on
     * initial load so truck markers appear immediately, even before any
     * live `driver_moving` event arrives from the driver app.
     *
     * @returns {Promise<{locations: Array<{
     *   dispatchKey: string,
     *   driverId: string|null,
     *   driverName: string|null,
     *   truckPlate: string|null,
     *   tripStatus: string|null,
     *   lat: number|null,
     *   lng: number|null,
     *   at: number|null,
     * }>>}
     */
    async fetchActiveLocations() {
        return request(`${API_CONFIG.BASE_URL}/api/sap/locations`, {method: "GET"});
    },
};
