const STAFF = new Set(["fleet_manager", "admin", "super_admin"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function serialize(value) {
    if (value && typeof value.toMillis === "function") return {$timestamp: value.toMillis()};
    if (Array.isArray(value)) return value.map(serialize);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
    }
    return value;
}

function createRealtimeSubscriptions({db}) {
    return function bindRealtimeSubscriptions(socket) {
        const subscriptions = new Map();
        const stopAll = () => {
            for (const stop of subscriptions.values()) stop();
            subscriptions.clear();
        };
        socket.on("realtime:subscribe", (request, acknowledge) => {
            const ack = typeof acknowledge === "function" ? acknowledge : () => {};
            if (!request || typeof request !== "object" || Array.isArray(request)
                || !ID_PATTERN.test(request.id || "") || typeof request.topic !== "string") {
                ack({success: false, message: "Invalid subscription"});
                return;
            }
            const {id, topic, params = {}} = request;
            if (!params || typeof params !== "object" || Array.isArray(params)
                || Buffer.byteLength(JSON.stringify(params)) > 512 || subscriptions.has(id)
                || subscriptions.size >= 20) {
                ack({success: false, message: "Invalid or excessive subscription"});
                return;
            }
            const role = socket.data.role;
            const uid = socket.data.uid;
            let ref;
            let document = false;
            let collectionName;
            if (topic === "profile") {
                collectionName = "users";
                ref = db.collection(collectionName).doc(uid);
                document = true;
            } else if (topic === "queue" && (STAFF.has(role) || role === "qr_generator")) {
                collectionName = "queue";
                const max = role === "qr_generator" ? 50 : 100;
                const order = params.order === "desc" ? "desc" : "asc";
                const limit = Number.isInteger(params.limit) ? Math.min(max, Math.max(1, params.limit)) : max;
                ref = db.collection(collectionName).orderBy("entryTime", order).limit(limit);
            } else if (topic === "drivers" && (STAFF.has(role) || role === "driver")) {
                collectionName = "drivers";
                ref = role === "driver" ? db.collection(collectionName).doc(uid)
                    : db.collection(collectionName);
                document = role === "driver";
            } else if (topic === "locations" && (STAFF.has(role) || role === "driver")) {
                collectionName = "driver_locations";
                ref = role === "driver" ? db.collection(collectionName).doc(uid)
                    : db.collection(collectionName);
                document = role === "driver";
            } else if (topic === "assignments" && (STAFF.has(role) || role === "driver")) {
                collectionName = "sap_assignments";
                ref = role === "driver" ? db.collection(collectionName).where("driverId", "==", uid)
                    : db.collection(collectionName);
            } else if (topic === "users" && STAFF.has(role)) {
                collectionName = "users";
                ref = db.collection(collectionName);
            } else if (topic === "incidents") {
                collectionName = "incidents";
                ref = db.collection(collectionName).where("reporterId", "==", uid);
            } else if (topic === "overrideRequests" && STAFF.has(role)) {
                collectionName = "overrideRequests";
                ref = db.collection(collectionName).orderBy("requestedAt", "desc").limit(50);
            } else if (topic === "cancelRequests" && STAFF.has(role)) {
                collectionName = "cancelRequests";
                ref = db.collection(collectionName).orderBy("requestedAt", "desc").limit(50);
            } else if (topic === "legacyOverrideRequests" && STAFF.has(role)) {
                collectionName = "override_requests";
                const statuses = new Set(["pending", "approved", "rejected", "expired", "completed"]);
                ref = db.collection(collectionName);
                if (statuses.has(params.status)) ref = ref.where("status", "==", params.status);
            } else if (topic === "truckCompanies") {
                collectionName = "truck_company";
                ref = db.collection(collectionName);
            } else if (topic === "securityGuards") {
                collectionName = "security_guard";
                ref = db.collection(collectionName);
            } else {
                ack({success: false, message: "Subscription not authorized"});
                return;
            }

            const stop = ref.onSnapshot(snapshot => {
                let data = document
                    ? (snapshot.exists ? {id: snapshot.id, ...serialize(snapshot.data())} : null)
                    : snapshot.docs.map(item => ({id: item.id, ...serialize(item.data())}));
                if (role === "qr_generator" && topic === "queue" && Array.isArray(data)) {
                    data = data.map(({id: docId, driverId, driverName, plateNumber, truckType, status, entryTime}) =>
                        ({id: docId, driverId, driverName, plateNumber, truckType, status, entryTime}));
                }
                socket.emit("realtime:state", {id, topic, data});
            }, () => socket.emit("realtime:error", {id, topic, message: "Realtime data unavailable"}));
            subscriptions.set(id, stop);
            ack({success: true, id, topic, collection: collectionName});
        });
        socket.on("realtime:unsubscribe", (request, acknowledge) => {
            const ack = typeof acknowledge === "function" ? acknowledge : () => {};
            const id = request?.id;
            const stop = ID_PATTERN.test(id || "") ? subscriptions.get(id) : null;
            if (stop) {
                stop();
                subscriptions.delete(id);
            }
            ack({success: true});
        });
        socket.once("disconnect", stopAll);
    };
}

function createProfileRealtimeSubscriptions({db}) {
    return function bindProfileRealtimeSubscriptions(socket) {
        const subscriptions = new Map();
        const stopAll = () => {
            for (const stop of subscriptions.values()) stop();
            subscriptions.clear();
        };
        socket.on("realtime:subscribe", (request, acknowledge) => {
            const ack = typeof acknowledge === "function" ? acknowledge : () => {};
            if (!request || typeof request !== "object" || Array.isArray(request)
                || !ID_PATTERN.test(request.id || "") || request.topic !== "profile"
                || (request.params != null && (typeof request.params !== "object"
                    || Array.isArray(request.params) || Object.keys(request.params).length !== 0))
                || subscriptions.has(request.id) || subscriptions.size >= 1) {
                ack({success: false, message: "Invalid profile subscription"});
                return;
            }
            const {id, topic} = request;
            const ref = db.collection("users").doc(socket.data.uid);
            const stop = ref.onSnapshot(snapshot => {
                const data = snapshot.exists
                    ? {id: snapshot.id, ...serialize(snapshot.data())}
                    : null;
                socket.emit("realtime:state", {id, topic, data});
            }, () => socket.emit("realtime:error", {id, topic, message: "Profile unavailable"}));
            subscriptions.set(id, stop);
            ack({success: true, id, topic});
        });
        socket.on("realtime:unsubscribe", (request, acknowledge) => {
            const ack = typeof acknowledge === "function" ? acknowledge : () => {};
            const stop = ID_PATTERN.test(request?.id || "") ? subscriptions.get(request.id) : null;
            if (stop) {
                stop();
                subscriptions.delete(request.id);
            }
            ack({success: true});
        });
        socket.once("disconnect", stopAll);
    };
}

module.exports = {createRealtimeSubscriptions, createProfileRealtimeSubscriptions, serialize};
