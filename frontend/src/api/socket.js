import {io} from "socket.io-client";
import {API_CONFIG} from "./config.js";
import {auth} from "./firebase.js";

let sessionGeneration = 0;
let _driverSocket = null;
let _profileSocket = null;
let driverConnectionRequested = false;

// Resolve the current account on every handshake/reconnect. An old async token
// result must never be applied after logout or a newer account/token event.
const currentTokenAuth = async (callback) => {
    const user = auth.currentUser;
    const generation = sessionGeneration;
    if (!user) return callback({});
    try {
        const token = await user.getIdToken();
        callback(auth.currentUser === user && generation === sessionGeneration ? {token} : {});
    } catch (_) {
        callback({});
    }
};

export const socket = io(API_CONFIG.SOCKET_URL, {
    autoConnect: false, // Don't connect until we have a token
    reconnection: true,
    transports: ["websocket"],
    auth: currentTokenAuth,
});

const connectAuthenticated = async (target) => {
    const user = auth.currentUser;
    const generation = sessionGeneration;
    if (!user) {
        target.disconnect();
        return;
    }
    try {
        await user.getIdToken();
        if (auth.currentUser === user && generation === sessionGeneration) target.connect();
    } catch (_) {
        if (auth.currentUser === user && generation === sessionGeneration) target.disconnect();
    }
};

export const connectSocket = () => connectAuthenticated(socket);
export const connectProfileSocket = () => connectAuthenticated(getProfileSocket());
export const connectDriverSocket = () => {
    driverConnectionRequested = true;
    return connectAuthenticated(getDriverSocket());
};

auth.onIdTokenChanged(async (user) => {
    const generation = ++sessionGeneration;
    const reconnectDriver = driverConnectionRequested || _driverSocket?.active || _driverSocket?.connected;
    socket.disconnect();
    _driverSocket?.disconnect();
    _profileSocket?.disconnect();
    if (!user) { driverConnectionRequested = false; return; }
    try {
        await user.getIdToken();
        if (auth.currentUser !== user || generation !== sessionGeneration) return;
        socket.connect();
        getProfileSocket().connect();
        if (reconnectDriver) _driverSocket?.connect();
    } catch (_) {
        console.error("[socket] Firebase token unavailable; realtime sockets remain disconnected");
    }
});

socket.on("connect", () => {
    // Socket connected silently in production
});

socket.on("connect_error", (err) => {
    console.error("Socket connection error:", err.message);
});

socket.on("disconnect", () => {
    // Silently disconnected
});

export const EVENTS = {
    DRIVER_MOVING: "update_admin_map",
    STATUS_UPDATE: "vendor_status_update",
    WAREHOUSE_BASE_UPDATED: "warehouse_base_updated",
    SAVE_WAREHOUSE_BASE: "save_warehouse_base",
    GET_WAREHOUSE_BASE: "get_warehouse_base",
    ROLE_REQUEST_CREATED: "role_request_created",
    ROLE_REQUEST_UPDATED: "role_request_updated",
    GET_ROLE_REQUESTS: "get_role_requests",
    CREATE_ROLE_REQUEST: "create_role_request",
    APPROVE_ROLE_REQUEST: "approve_role_request",
    REJECT_ROLE_REQUEST: "reject_role_request",
    USER_ROLE_CHANGED: "user_role_changed",
    POD_UPDATED: "pod_updated",
};

// ── Driver-Location Socket ─────────────────────────────────────────────────
// Secondary socket that connects directly to the driver-app server
// (VITE_DRIVER_TRACKING_URL) and receives driver_moving / update_status events.
// Sysu-app's main socket connects to sysu-app's own backend and carries
// vendor/assignment events (update_admin_map, vendor_status_update).
// These two sockets operate independently and can coexist.
// ─────────────────────────────────────────────────────────────────────────────

export const getDriverSocket = () => {
    if (_driverSocket) return _driverSocket;

    _driverSocket = io(API_CONFIG.DRIVER_TRACKING_URL, {
        autoConnect: false,
        reconnection: true,
        reconnectionDelayMax: 10000,
        transports: ["websocket"],
        auth: currentTokenAuth,
    });

    return _driverSocket;
};

export const getProfileSocket = () => {
    if (_profileSocket) return _profileSocket;
    _profileSocket = io(`${API_CONFIG.SOCKET_URL}/profile`, {
        autoConnect: false,
        reconnection: true,
        transports: ["websocket"],
        auth: currentTokenAuth,
    });
    return _profileSocket;
};
