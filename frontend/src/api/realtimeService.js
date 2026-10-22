import * as socketApi from "./socket.js";
import {auth} from "./firebase.js";
const {socket} = socketApi;
const getProfileSocket = socketApi.getProfileSocket || (() => null);

let nextId = 0;
const subscriptions = new Map();
let currentUserId = auth.currentUser?.uid ?? null;

auth.onAuthStateChanged((user) => {
    const nextUserId = user?.uid ?? null;
    if (nextUserId === currentUserId) return;
    currentUserId = nextUserId;
    for (const subscription of subscriptions.values()) {
        const target = socketFor(subscription.topic);
        if (target?.connected) target.emit("realtime:unsubscribe", {id: subscription.id});
    }
    subscriptions.clear();
});

const applyState = ({id, topic, data} = {}) => {
    const subscription = subscriptions.get(id);
    if (subscription?.topic === "profile") {
        console.log("[realtime] profile state received", {hasProfile: data != null});
    }
    if (subscription && subscription.topic === topic) subscription.next(data);
};

const applyError = ({id, message} = {}) => {
    const subscription = subscriptions.get(id);
    if (subscription) {
        if (subscription.topic === "profile") {
            console.error("[realtime] profile subscription error", {message: message || "Realtime data unavailable"});
        }
        subscription.error(new Error(message || "Realtime data unavailable"));
    }
};

function socketFor(topic) {
    return topic === "profile" ? getProfileSocket() : socket;
}

function restoreSubscriptions(target) {
    for (const subscription of subscriptions.values()) {
        if (socketFor(subscription.topic) === target) emitSubscription(target, subscription);
    }
}

function emitSubscription(target, subscription) {
    if (subscription.topic !== "profile") {
        target.emit("realtime:subscribe", subscription.request);
        return;
    }
    console.log("[realtime] sending profile subscription");
    target.emit("realtime:subscribe", subscription.request, (result) => {
        console.log("[realtime] profile subscription acknowledgement", {
            success: result?.success === true,
            message: result?.success === false ? result.message : null,
        });
        if (result?.success === false) {
            applyError({id: subscription.id, message: result.message});
        }
    });
}

for (const target of [socket, getProfileSocket()]) {
    if (!target?.on) continue;
    target.on("realtime:state", applyState);
    target.on("realtime:error", applyError);
    target.on("connect", () => {
        if (target === getProfileSocket()) console.log("[realtime] profile socket connected");
        restoreSubscriptions(target);
    });
    if (target === getProfileSocket()) {
        target.on("connect_error", (error) => {
            console.error("[realtime] profile socket connection failed", {message: error.message});
        });
        target.on("disconnect", (reason) => {
            console.warn("[realtime] profile socket disconnected", {reason});
            if (reason === "io server disconnect") {
                for (const subscription of subscriptions.values()) {
                    if (subscription.topic === "profile") {
                        applyError({id: subscription.id, message: "Profile authorization ended"});
                    }
                }
            }
        });
    }
}

function timestamp(value) {
    return value && typeof value === "object" && Number.isFinite(value.$timestamp)
        ? {toMillis: () => value.$timestamp, toDate: () => new Date(value.$timestamp)}
        : value;
}

function decode(value) {
    if (Array.isArray(value)) return value.map(decode);
    if (!value || typeof value !== "object") return value;
    if (Number.isFinite(value.$timestamp)) return timestamp(value);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
}

export function asCollectionSnapshot(rows = []) {
    const docs = rows.map(row => ({id: row.id, data: () => decode(row)}));
    return {docs, empty: docs.length === 0, size: docs.length, forEach: callback => docs.forEach(callback)};
}

export function asDocumentSnapshot(value, id) {
    return {id, exists: () => value != null, data: () => value == null ? undefined : decode(value)};
}

export function subscribeRealtime(topic, params, next, error = () => {}) {
    const id = `web-${++nextId}`;
    const request = {id, topic, params: params || {}};
    subscriptions.set(id, {id, topic, request, next, error});
    const target = socketFor(topic);
    if (topic === "profile") {
        console.log("[realtime] profile subscription requested", {socketConnected: Boolean(target?.connected)});
    }
    if (target?.connected) emitSubscription(target, subscriptions.get(id));
    return () => {
        subscriptions.delete(id);
        if (target?.connected) target.emit("realtime:unsubscribe", {id});
    };
}
