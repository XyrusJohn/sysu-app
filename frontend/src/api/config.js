// In dev (vite): VITE_API_URL / VITE_SOCKET_URL from .env.development.local override .env defaults
// In build: VITE_API_URL / VITE_SOCKET_URL from .env become the production values
const isLocalhost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";

export const API_CONFIG = {
    // REST API server
    BASE_URL: import.meta.env.VITE_API_URL || "https://sysu-app-production.up.railway.app",
    // Socket.IO server for sysu-app events (vendor/assignment → update_admin_map, vendor_status_update)
    SOCKET_URL: import.meta.env.VITE_SOCKET_URL || "https://sysu-app-production.up.railway.app",
    // Driver-location Socket.IO server (sysu-go-production where the mobile app sends real-time GPS coordinates)
    DRIVER_TRACKING_URL: import.meta.env.VITE_DRIVER_TRACKING_URL || "https://sysu-go-production.up.railway.app",
};
