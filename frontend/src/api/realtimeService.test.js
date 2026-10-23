import {beforeEach, expect, test, vi} from "vitest";

const sockets = vi.hoisted(() => {
    const makeSocket = () => ({
        connected: false,
        handlers: new Map(),
        emitted: [],
        on(event, callback) { this.handlers.set(event, callback); },
        emit(event, payload, acknowledge) {
            const entry = {event, payload};
            if (typeof acknowledge === "function") entry.acknowledge = acknowledge;
            this.emitted.push(entry);
        },
        fire(event, payload) { this.handlers.get(event)?.(payload); },
    });
    return {main: makeSocket(), profile: makeSocket()};
});
const authState = vi.hoisted(() => ({uid: null, listeners: []}));

vi.mock("./socket.js", () => ({
    socket: sockets.main,
    getProfileSocket: () => sockets.profile,
}));
vi.mock("./firebase.js", () => ({
    auth: {
        get currentUser() { return authState.uid ? {uid: authState.uid} : null; },
        onAuthStateChanged(callback) {
            authState.listeners.push(callback);
            callback(authState.uid ? {uid: authState.uid} : null);
            return () => {};
        },
    },
}));

import {asCollectionSnapshot, asDocumentSnapshot, subscribeRealtime} from "./realtimeService.js";

beforeEach(() => {
    authState.uid = null;
    authState.listeners.forEach(listener => listener(null));
    for (const target of [sockets.main, sockets.profile]) {
        target.connected = false;
        target.emitted.length = 0;
    }
});

test("subscriptions are cleared at account boundaries and never restore into another user session", () => {
    authState.uid = "user-a";
    authState.listeners.forEach(listener => listener({uid: "user-a"}));
    subscribeRealtime("assignments", {}, vi.fn());
    sockets.main.connected = true;
    sockets.main.fire("connect");
    expect(sockets.main.emitted.filter(item => item.event === "realtime:subscribe")).toHaveLength(1);

    authState.uid = null;
    authState.listeners.forEach(listener => listener(null));
    authState.uid = "user-b";
    authState.listeners.forEach(listener => listener({uid: "user-b"}));
    sockets.main.fire("connect");
    expect(sockets.main.emitted.filter(item => item.event === "realtime:subscribe")).toHaveLength(1);
});

test("subscriptions restore on reconnect and unsubscribe from the owning socket", () => {
    const receive = vi.fn();
    const stop = subscribeRealtime("assignments", {}, receive);
    expect(sockets.main.emitted).toHaveLength(0);
    sockets.main.connected = true;
    sockets.main.fire("connect");
    const request = sockets.main.emitted[0].payload;
    expect(request.topic).toBe("assignments");
    sockets.main.fire("realtime:state", {id: request.id, topic: "assignments", data: [{id: "a1"}]});
    expect(receive).toHaveBeenCalledWith([{id: "a1"}]);
    sockets.main.fire("connect");
    expect(sockets.main.emitted).toHaveLength(2);
    stop();
    expect(sockets.main.emitted.at(-1)).toEqual({event: "realtime:unsubscribe", payload: {id: request.id}});
});

test("initial connection failures reach the subscriber once while reconnecting", () => {
    const error = vi.fn();
    const stop = subscribeRealtime("queue", {}, vi.fn(), error);

    sockets.main.fire("connect_error", new Error("offline"));
    sockets.main.fire("connect_error", new Error("offline again"));

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0].message).toContain("Check your internet connection");
    stop();
});

test("profile subscriptions use their isolated namespace and preserve document existence", () => {
    const receive = vi.fn();
    const stop = subscribeRealtime("profile", {}, receive);
    sockets.profile.connected = true;
    sockets.profile.fire("connect");
    const request = sockets.profile.emitted[0].payload;
    sockets.profile.fire("realtime:state", {id: request.id, topic: "profile", data: {id: "u1", role: "pending"}});
    const snapshot = asDocumentSnapshot(receive.mock.calls[0][0], "u1");
    expect(snapshot.exists()).toBe(true);
    expect(snapshot.data().role).toBe("pending");
    stop();
    expect(sockets.profile.emitted.at(-1).event).toBe("realtime:unsubscribe");
});

test("profile subscription acknowledgement failures reach the subscriber error handler", () => {
    sockets.profile.connected = true;
    const error = vi.fn();
    subscribeRealtime("profile", {}, vi.fn(), error);
    const subscription = sockets.profile.emitted.at(-1);

    subscription.acknowledge({success: false, message: "Subscription unavailable"});

    expect(error).toHaveBeenCalledWith(new Error("Subscription unavailable"));
});

test("subscriptions report a bounded initial snapshot timeout and stop the deadline after data arrives", () => {
    vi.useFakeTimers();
    const error = vi.fn();
    const receive = vi.fn();
    const stop = subscribeRealtime("queue", {}, receive, error);

    vi.advanceTimersByTime(20_000);
    expect(error).toHaveBeenCalledOnce();

    sockets.main.connected = true;
    const nextError = vi.fn();
    const stopNext = subscribeRealtime("assignments", {}, vi.fn(), nextError);
    const request = sockets.main.emitted.at(-1)?.payload;
    sockets.main.fire("realtime:state", {id: request?.id, topic: "assignments", data: []});
    vi.advanceTimersByTime(20_000);
    expect(nextError).not.toHaveBeenCalled();

    stop();
    stopNext();
    vi.useRealTimers();
});

test("server-revoked profile socket fails closed while transient disconnect can reconnect", () => {
    const error = vi.fn();
    const stop = subscribeRealtime("profile", {}, vi.fn(), error);
    sockets.profile.fire("disconnect", "transport close");
    expect(error).not.toHaveBeenCalled();
    sockets.profile.fire("disconnect", "io server disconnect");
    expect(error).toHaveBeenCalledWith(new Error("Profile authorization ended"));
    stop();
});

test("collection snapshots retain Firestore-style iteration and timestamp access", () => {
    const snapshot = asCollectionSnapshot([{id: "q1", entryTime: {$timestamp: 1000}}]);
    expect(snapshot.size).toBe(1);
    expect(snapshot.docs[0].data().entryTime.toDate().getTime()).toBe(1000);
    expect(snapshot.empty).toBe(false);
});
