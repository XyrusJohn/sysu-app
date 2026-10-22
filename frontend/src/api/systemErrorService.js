import {API_CONFIG} from './config.js';
import {AuthService} from './authService.js';
import {socket} from './socket.js';

const API = `${API_CONFIG.BASE_URL}/api/system-errors`;
const pendingReports = [];
const recentReports = new Map();
let flushing = false;
let installed = false;
const recentUserNotifications = new Map();

function notifyUser(onError, key, message) {
    if (typeof onError !== 'function') return;
    const now = Date.now();
    if (now - (recentUserNotifications.get(key) || 0) < 30_000) return;
    recentUserNotifications.set(key, now);
    onError(message);
}

async function request(path, options = {}) {
    const token = await AuthService.getToken();
    const response = await fetch(`${API}${path}`, {
        ...options,
        headers: {Authorization: `Bearer ${token}`, ...(options.headers || {})},
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.error || 'System logs are temporarily unavailable.');
        error.requestId = payload.requestId || null;
        throw error;
    }
    return payload;
}

export const SystemErrorService = {
    list() {
        return request('/logs?limit=100&openOnly=false').then(result => result.items || []);
    },
    resolve(id) {
        return request(`/logs/${encodeURIComponent(id)}/resolve`, {method: 'PATCH'});
    },
    report(eventCode, {operation, errorName} = {}) {
        if (!['frontend_uncaught', 'frontend_unhandled_rejection', 'frontend_operation_failure'].includes(eventCode)) return;
        const now = Date.now();
        const key = `${eventCode}:${operation || ''}:${errorName || ''}`;
        if (now - (recentReports.get(key) || 0) < 60_000) return;
        recentReports.set(key, now);
        pendingReports.push({eventCode, operation, errorName});
        if (pendingReports.length > 20) pendingReports.shift();
        void this.flushReports();
    },
    async flushReports() {
        if (flushing || pendingReports.length === 0) return;
        flushing = true;
        try {
            while (pendingReports.length) {
                const report = pendingReports[0];
                await request('/report', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(report),
                });
                pendingReports.shift();
            }
        } catch {
            // Keep a small in-memory queue for the next authenticated socket reconnect.
        } finally {
            flushing = false;
        }
    },
    installGlobalHandlers(onError) {
        if (installed || typeof window === 'undefined') return;
        installed = true;
        window.addEventListener('error', event => {
            this.report('frontend_uncaught', {
                operation: 'dashboard-runtime',
                errorName: event.error?.name || 'Error',
            });
            notifyUser(onError, 'runtime', 'May hindi inaasahang nangyari. Subukan muli; kung magpatuloy, makipag-ugnayan sa administrator.');
        });
        window.addEventListener('unhandledrejection', event => {
            this.report('frontend_unhandled_rejection', {
                operation: 'dashboard-async',
                errorName: event.reason?.name || 'Error',
            });
            notifyUser(onError, 'async', 'Hindi nakumpleto ang isang proseso. Suriin ang koneksyon at subukan muli.');
        });
        socket.on('connect_error', error => {
            this.report('frontend_operation_failure', {
                operation: 'realtime-connection',
                errorName: error?.name || 'Error',
            });
            notifyUser(onError, 'realtime', 'Nawala ang live connection. Awtomatikong susubukan itong ikonekta muli.');
        });
        socket.on('connect', () => void this.flushReports());
    },
};
