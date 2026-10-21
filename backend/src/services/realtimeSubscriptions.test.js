const test = require("node:test");
const assert = require("node:assert/strict");
const {createRealtimeSubscriptions, createProfileRealtimeSubscriptions, serialize} = require("./realtimeSubscriptions");

function fixture(role = "admin", uid = "staff-1") {
    const handlers = new Map();
    const emitted = [];
    const stopped = [];
    const socket = {
        data: {role, uid},
        on: (event, callback) => handlers.set(event, callback),
        once: (event, callback) => handlers.set(`${event}:once`, callback),
        emit: (event, payload) => emitted.push({event, payload}),
    };
    const ref = {
        orderBy: () => ref,
        limit: () => ref,
        where: () => ref,
        doc: () => ref,
        onSnapshot: (next) => {
            ref.next = next;
            return () => stopped.push(true);
        },
    };
    const db = {collection: () => ref};
    createRealtimeSubscriptions({db})(socket);
    return {handlers, emitted, stopped, ref, socket};
}

test("subscription sends a full serialized state and releases listener on disconnect", () => {
    const f = fixture();
    let ack;
    f.handlers.get("realtime:subscribe")({id: "queue-1", topic: "queue", params: {order: "asc", limit: 100}}, value => {ack = value;});
    assert.equal(ack.success, true);
    f.ref.next({docs: [{id: "q1", data: () => ({driverId: "d1", entryTime: {toMillis: () => 123}})}]});
    assert.deepEqual(f.emitted.at(-1), {event: "realtime:state", payload: {id: "queue-1", topic: "queue", data: [{id: "q1", driverId: "d1", entryTime: {$timestamp: 123}}]}});
    f.handlers.get("disconnect:once")();
    assert.deepEqual(f.stopped, [true]);
});

test("driver subscriptions are scoped to their own profile and location", () => {
    const f = fixture("driver", "driver-1");
    let profileAck;
    f.handlers.get("realtime:subscribe")({id: "profile-1", topic: "profile"}, value => {profileAck = value;});
    assert.equal(profileAck.success, true);
    assert.equal(f.ref.next != null, true);
    let usersAck;
    f.handlers.get("realtime:subscribe")({id: "users-1", topic: "users"}, value => {usersAck = value;});
    assert.equal(usersAck.success, false);
});

test("guard and truck company streams are admin-only, expose safe fields, and retain inactive admin records", () => {
    for (const role of ["driver", "fleet_manager", "qr_generator"]) {
        const f = fixture(role);
        for (const topic of ["securityGuards", "truckCompanies"]) {
            let ack;
            f.handlers.get("realtime:subscribe")({id: `${role}-${topic}`, topic}, value => {ack = value;});
            assert.equal(ack.success, false, `${role} must not subscribe to ${topic}`);
        }
    }

    for (const role of ["admin", "super_admin"]) {
        const f = fixture(role);
        for (const [topic, source, expected] of [
            ["securityGuards", {guardId: "G-1", firstName: "Sam", middleInitial: "A", lastName: "Lee", fullName: "Sam A Lee", active: true, signature: "private"},
                {id: "guard-1", guardId: "G-1", firstName: "Sam", middleInitial: "A", lastName: "Lee", fullName: "Sam A Lee", active: true}],
            ["truckCompanies", {companyCode: "TC-1", forwarderCode: "FWD", name: "Example Trucking", active: true, bankDetails: "private"},
                {id: "company-1", companyCode: "TC-1", forwarderCode: "FWD", name: "Example Trucking", active: true}],
        ]) {
            let ack;
            f.handlers.get("realtime:subscribe")({id: `${role}-${topic}`, topic}, value => {ack = value;});
            assert.equal(ack.success, true);
            const inactive = {...source, active: false};
            f.ref.next({docs: [{id: expected.id, data: () => source}, {id: `inactive-${expected.id}`, data: () => inactive}]});
            assert.deepEqual(f.emitted.at(-1).payload.data, [expected, {...expected, id: `inactive-${expected.id}`, active: false}]);
        }
    }
});

test("profile namespace binds correlated, own-profile subscriptions only", () => {
    const handlers = new Map();
    const emitted = [];
    const stopped = [];
    const socket = {
        data: {uid: "pending-user"},
        on: (event, callback) => handlers.set(event, callback),
        once: (event, callback) => handlers.set(`${event}:once`, callback),
        emit: (event, payload) => emitted.push({event, payload}),
    };
    const profileRef = {
        onSnapshot: callback => {
            profileRef.next = callback;
            return () => stopped.push(true);
        },
    };
    const db = {collection: name => ({doc: uid => {
        assert.equal(name, "users");
        assert.equal(uid, "pending-user");
        return profileRef;
    }})};
    createProfileRealtimeSubscriptions({db})(socket);

    let ack;
    handlers.get("realtime:subscribe")({id: "web-profile-1", topic: "profile", params: {}}, value => {ack = value;});
    assert.deepEqual(ack, {success: true, id: "web-profile-1", topic: "profile"});
    profileRef.next({exists: true, id: "pending-user", data: () => ({role: "pending", createdAt: {toMillis: () => 8}})});
    assert.deepEqual(emitted.at(-1), {event: "realtime:state", payload: {
        id: "web-profile-1", topic: "profile", data: {id: "pending-user", role: "pending", createdAt: {$timestamp: 8}},
    }});
    handlers.get("realtime:subscribe")({id: "other", topic: "users"}, value => {ack = value;});
    assert.equal(ack.success, false);
    handlers.get("realtime:unsubscribe")({id: "web-profile-1"}, () => {});
    assert.deepEqual(stopped, [true]);
});

test("invalid subscriptions and excessive fanout are rejected", () => {
    const f = fixture();
    let ack;
    f.handlers.get("realtime:subscribe")({id: "bad/id", topic: "users"}, value => {ack = value;});
    assert.equal(ack.success, false);
    for (let i = 0; i < 20; i++) {
        f.handlers.get("realtime:subscribe")({id: `sub-${i}`, topic: "users"}, () => {});
    }
    f.handlers.get("realtime:subscribe")({id: "sub-20", topic: "users"}, value => {ack = value;});
    assert.equal(ack.success, false);
});

test("timestamp serializer handles nested arrays and leaves primitives intact", () => {
    assert.deepEqual(serialize({created: {toMillis: () => 50}, rows: [{count: 2}]}), {
        created: {$timestamp: 50}, rows: [{count: 2}],
    });
});
