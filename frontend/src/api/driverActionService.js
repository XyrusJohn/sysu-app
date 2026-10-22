import { connectDriverSocket, EVENTS, getDriverSocket } from './socket.js';

const unwrap = (response) => {
    if (response?.success === false) throw new Error(response.message || 'Driver action data is unavailable.');
    return response?.data ?? response;
};

const waitForConnection = (target) => {
    if (target?.connected) return Promise.resolve();
    if (!target?.once) return Promise.reject(new Error('Driver action service is disconnected.'));
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            target.off?.('connect', onConnect);
            target.off?.('connect_error', onError);
            target.off?.('disconnect', onDisconnect);
        };
        const onConnect = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('Driver action service could not connect.')); };
        const onDisconnect = () => { cleanup(); reject(new Error('Driver action service disconnected.')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Driver action service connection timed out.')); }, 12000);
        target.once('connect', onConnect);
        target.once('connect_error', onError);
        target.once('disconnect', onDisconnect);
    });
};

const request = async (event, payload) => {
    await connectDriverSocket();
    const target = getDriverSocket();
    await waitForConnection(target);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Driver action request timed out.')), 12000);
        target.emit(event, payload, (response) => {
            clearTimeout(timeout);
            try { resolve(unwrap(response)); } catch (error) { reject(error); }
        });
    });
};

const rowsFrom = (value) => Array.isArray(value) ? value : (value?.items || value?.sessions || value?.events || []);

export const DriverActionService = {
    async getSessions(driverId, limit = 30, cursor) {
        const result = unwrap(await request(EVENTS.DRIVER_ACTIONS_GET_SESSIONS, {driverId, limit, ...(cursor ? {cursor} : {})}));
        return {items: newestFirst(rowsFrom(result)), nextCursor: result?.nextCursor ?? null};
    },
    async getEvents(driverId, sessionId, limit = 200, cursor) {
        const result = unwrap(await request(EVENTS.DRIVER_ACTIONS_GET_EVENTS, {driverId, sessionId, limit, ...(cursor ? {cursor} : {})}));
        return {items: newestFirst(rowsFrom(result)), nextCursor: result?.nextCursor ?? null};
    },
    subscribeUpdated(handler) {
        const target = getDriverSocket();
        target?.on(EVENTS.DRIVER_ACTIONS_UPDATED, handler);
        return () => target?.off(EVENTS.DRIVER_ACTIONS_UPDATED, handler);
    },
};

export const driverActionTimestamp = (value) => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : Date.parse(value);
    }
    if (value?.toMillis) return value.toMillis();
    if (Number.isFinite(value?._seconds)) return value._seconds * 1000;
    if (Number.isFinite(value?.seconds)) return value.seconds * 1000;
    return 0;
};

export const driverActionCoordinates = (item) => {
    if (item?.lat == null || item?.lng == null) return null;
    const lat = Number(item.lat), lng = Number(item.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return [lat, lng];
};

export const newestFirst = (rows) => [...(rows || [])].sort((a, b) => {
    const at = driverActionTimestamp(a?.startedAtMs ?? a?.occurredAtMs ?? a?.createdAt);
    const bt = driverActionTimestamp(b?.startedAtMs ?? b?.occurredAtMs ?? b?.createdAt);
    return bt - at;
});

export const eventsNewestFirst = (rows) => [...(rows || [])].sort((a, b) => {
    if (Number.isSafeInteger(a?.sequence) && Number.isSafeInteger(b?.sequence)) return b.sequence - a.sequence;
    return driverActionTimestamp(b?.occurredAtMs) - driverActionTimestamp(a?.occurredAtMs);
});

export const driverActionRouteCoordinates = (events) => [...(events || [])]
    .filter(item => item?.eventType === 'route_point')
    .sort((a, b) => Number.isSafeInteger(a.sequence) && Number.isSafeInteger(b.sequence)
        ? a.sequence - b.sequence
        : driverActionTimestamp(a.occurredAtMs) - driverActionTimestamp(b.occurredAtMs))
    .map(driverActionCoordinates)
    .filter(Boolean);
