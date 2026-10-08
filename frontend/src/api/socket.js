import {io} from "socket.io-client";
import {API_CONFIG} from "./config.js";
import {auth} from "./firebase.js";

export const socket = io(API_CONFIG.SOCKET_URL, {
    autoConnect: false, // Don't connect until we have a token
    reconnection: true,
    transports: ["websocket"],
});

// Function to connect with authentication
export const connectSocket = async () => {
    try {
        const user = auth.currentUser;
        if (!user) return;

        const token = await user.getIdToken(true);
        socket.auth = {token};
        socket.connect();
    } catch (err) {
        console.error("Socket token error:", err);
    }
};

// Auto-refresh token and reconnect if expired
auth.onIdTokenChanged(async (user) => {
    if (user) {
        const token = await user.getIdToken();
        socket.auth = {token};
        if (!socket.connected) {
            socket.connect();
        }
    } else {
        socket.disconnect();
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

let _driverSocket = null;

export const getDriverSocket = () => {
    if (_driverSocket) return _driverSocket;

    _driverSocket = io(API_CONFIG.DRIVER_TRACKING_URL, {
        autoConnect: false,
        reconnection: true,
        reconnectionDelayMax: 10000,
        transports: ["websocket"],
    });

    return _driverSocket;
};
