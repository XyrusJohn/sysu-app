async function authedFetch(url, options = {}) {
    const {AuthService} = await import("./authService.js");
    const token = await AuthService.getToken();
    const response = await fetch(url, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...(options.headers || {}),
        },
    });

    let body;
    try {
        body = await response.json();
    } catch (e) {
        body = null;
    }

    if (!response.ok) {
        const error = new Error(
            (body && body.message) || `HTTP ${response.status}`,
        );
        error.status = response.status;
        error.body = body;
        throw error;
    }

    return body;
}

async function adminUrl(path = "") {
    const {API_CONFIG} = await import("./config.js");
    return `${API_CONFIG.BASE_URL}/api/admin/truck-companies${path}`;
}

export const TruckCompanyService = {
    /**
     * Subscribe to all truck_company docs. Callback receives a
     * map keyed by docSnap.id. Returns the unsubscribe function.
     */
    async subscribe(callback, onError) {
        const {subscribeRealtime, asCollectionSnapshot} = await import("./realtimeService.js");
        return subscribeRealtime("truckCompanies", {}, (rows) => {
                const map = {};
                asCollectionSnapshot(rows).forEach((docSnap) => {
                    map[docSnap.id] = {
                        id: docSnap.id,
                        ...docSnap.data(),
                    };
                });
                callback(map);
            }, (error) => {
                console.error("TruckCompanyService subscribe error:", error);
                if (onError) onError(error);
                else callback({});
            });
    },

    /**
     * Create a new truck company. Server returns the created record
     * (including generated companyCode).
     */
    async create({forwarderCode, name}) {
        const url = await adminUrl();
        return authedFetch(url, {
            method: "POST",
            body: JSON.stringify({forwarderCode, name}),
        });
    },

    /**
     * Update editable truck company fields (forwarderCode, name).
     */
    async update(code, {forwarderCode, name}) {
        const url = await adminUrl(`/${encodeURIComponent(code)}`);
        return authedFetch(url, {
            method: "PATCH",
            body: JSON.stringify({forwarderCode, name}),
        });
    },

    /**
     * Soft-delete (or reactivate) a truck company by flipping the
     * active flag.
     */
    async setActive(code, active) {
        const url = await adminUrl(`/${encodeURIComponent(code)}/active`);
        return authedFetch(url, {
            method: "PATCH",
            body: JSON.stringify({active}),
        });
    },

    async delete(code) {
        const url = await adminUrl(`/${encodeURIComponent(code)}`);
        return authedFetch(url, {method: "DELETE"});
    },

    /**
     * Pure client-side search. Case-insensitive substring match across
     * companyCode, name, and forwarderCode. Empty/whitespace query
     * returns docs unchanged.
     */
    search(query, docs) {
        if (query == null) return docs;
        const trimmed = String(query).trim();
        if (trimmed === "") return docs;
        const needle = trimmed.toLowerCase();
        return docs.filter((doc) => {
            const fields = [
                doc && doc.companyCode,
                doc && doc.name,
                doc && doc.forwarderCode,
            ];
            return fields.some(
                (value) =>
                    typeof value === "string" &&
                    value.toLowerCase().includes(needle),
            );
        });
    },
};
