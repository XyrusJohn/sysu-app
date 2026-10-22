const express = require("express");
const {Server} = require("socket.io");
const http = require("http");
const {initializeFirebase, admin} = require("./config/firebase");
const dotenv = require("dotenv");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("node-cron");

dotenv.config();
const runtimeConfig = require("./config/runtime").loadRuntimeConfig(process.env);
const port = runtimeConfig.port;

initializeFirebase();

const authRoutes = require("./routes/authRoute.js");
const sapRoutes = require("./routes/sapRoute.js");
const sapAssignmentRoutes = require("./routes/sapAssignmentRoute.js");
const userRoutes = require("./routes/userRoute.js");
const qrRoutes = require("./routes/qrRoute.js");
const driverRoutes = require("./routes/driverRoute.js");
const adminRoutes = require("./routes/adminRoute.js");
const systemDiagnosticsRoutes = require("./routes/systemDiagnosticsRoute.js");
const { startCleanupScheduler } = require("./utils/qrTokenCleanup");
const { startCleanupScheduler: startQueueCleanup } = require("./utils/queueCleanup");
const { startCleanupScheduler: startIncidentCleanup } = require("./utils/incidentCleanup");

const app = express();
app.use(helmet({contentSecurityPolicy: false}));
app.use((req, res, next) => {
    req.requestId = require('node:crypto').randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    next();
});
app.use(require('./middleware/systemErrorResponseLogger').systemErrorResponseLogger);
// Health probes bypass office/API traffic quotas and never disclose credentials.
app.use('/health', require('./routes/healthRoute')({
    probe: () => admin.firestore().doc('_health/readiness').get(),
    version: (process.env.RELEASE_VERSION || require('../package.json').version).slice(0, 128),
    timeoutMs: runtimeConfig.readinessTimeoutMs,
}));

// ── Global Middleware ──
const { errorHandler } = require("./middleware/errorHandler");

// ── Rate limiting ──
app.set("trust proxy", runtimeConfig.trustProxy);

const allowedOrigins = runtimeConfig.allowedOrigins;
app.use(require("./middleware/corsPolicy")(allowedOrigins));

const globalLimiter = rateLimit({
    windowMs: runtimeConfig.rateWindowMs,
    max: runtimeConfig.globalLimit,
    standardHeaders: true,
    legacyHeaders: false,
});
const authLimiter = rateLimit({
    windowMs: runtimeConfig.rateWindowMs,
    max: runtimeConfig.authLimit,
    standardHeaders: true,
    legacyHeaders: false,
});

const adminLimiter = rateLimit({
    windowMs: runtimeConfig.rateWindowMs,
    max: runtimeConfig.adminLimit,
    standardHeaders: true,
    legacyHeaders: false,
});

// Frequent kiosk reads share a bounded quota without exhausting other API requests.
const queueReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use((req, res, next) => {
    const isQueueRead = req.method === "GET" &&
        ["/api/qr/queue-display", "/api/qr/queue-cards"].includes(req.path);
    return (isQueueRead ? queueReadLimiter : globalLimiter)(req, res, next);
});
app.use("/api/auth", authLimiter);
app.use("/api/users", adminLimiter);

app.use(express.json({limit: "10kb"}));
app.use("/api/auth", authRoutes);
app.use("/api/sap", sapRoutes);
app.use("/api/sap", sapAssignmentRoutes);
app.use("/api/users", userRoutes);
app.use("/api/qr", qrRoutes);
app.use("/api/drivers", driverRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/system-errors", systemDiagnosticsRoutes);

app.use(errorHandler);

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        allowedHeaders: ["Authorization"],
        credentials: true,
    },
});

/* ── Public QR namespace — no auth required ── */
const qrNs = io.of("/qr");
qrNs.on("connection", () => {
    // Public — no auth needed. qr-generator.html listens here for qr_token_used events.
});

// Profiles use a separate namespace so pending users can read only their own
// profile without weakening the active-role checks on the application socket.
const profileNs = io.of("/profile");
if (typeof profileNs.use === "function") profileNs.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        if (typeof token !== "string") return next(new Error("Unauthorized"));
        const decoded = await admin.auth().verifyIdToken(token, true);
        socket.data.uid = decoded.uid;
        next();
    } catch {
        next(new Error("Unauthorized"));
    }
});
if (typeof profileNs.on === "function") profileNs.on("connection", (socket) => {
    require("./services/realtimeSubscriptions")
        .createProfileRealtimeSubscriptions({db: admin.firestore()})(socket);
    require("./services/socketSession").watchSocketSession(socket, socket.handshake.auth.token,
        token => admin.auth().verifyIdToken(token, true), {setTimeout, clearTimeout});
});

/* ── io exported so controllers can emit events ── */
global._io = io;
global._qrNs = qrNs;

const {
    getWarehouseBaseConfig,
    saveWarehouseBaseConfig,
} = require("./controllers/admin/warehouseBaseController.js");

const {
    getRoleRequests,
    createRoleRequest,
    approveRoleRequest,
    rejectRoleRequest,
} = require("./controllers/admin/roleRequestController.js");

// ── Location persistence throttle (10 minutes) & Smart Movement Check (>=100m) to save Firestore quota ──
const LOCATION_PERSIST_THROTTLE_MS = 10 * 60 * 1000;
const MIN_PERSIST_DISTANCE_METERS = 100;
const lastDriverLocationPersist = new Map(); // driverId -> { time, lat, lng }

function getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        if (!token || typeof token !== 'string') return next(new Error('Unauthorized'));
        const decoded = await require("firebase-admin").auth().verifyIdToken(token, true);
        socket.data.uid = decoded.uid;
        const profile = await admin.firestore().collection('users').doc(decoded.uid).get();
        const userData = profile.data();
        if (!profile.exists || !userData || userData.status !== 'active'
            || !['driver', 'fleet_manager', 'admin', 'super_admin', 'viewer', 'qr_generator'].includes(userData.role)) {
            return next(new Error('Unauthorized'));
        }
        socket.data.role = userData.role;
        socket.data.expiresAt = decoded.exp * 1000;
        next();
    } catch {
        next(new Error('Unauthorized'));
    }
});

io.on("connection", async (socket) => {
    require('./services/realtimeSubscriptions')
        .createRealtimeSubscriptions({db: admin.firestore()})(socket);
    require('./services/socketSession').watchSocketSession(socket, socket.handshake.auth.token,
        token => admin.auth().verifyIdToken(token, true), {setTimeout, clearTimeout});
    socket.join(`user:${socket.data.uid}`);
    if (['fleet_manager', 'admin', 'super_admin'].includes(socket.data.role)) socket.join('dispatchers');
    if (['admin', 'super_admin'].includes(socket.data.role)) socket.join('role-reviewers');
    if (['admin', 'super_admin'].includes(socket.data.role)) socket.join('ops-admins');
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.expiresAt - Date.now()));
    expiryTimer.unref?.();
    const stopProfile = admin.firestore().collection('users').doc(socket.data.uid).onSnapshot(snapshot => {
        const data = snapshot.data();
        if (!snapshot.exists || !data || data.status !== 'active'
            || data.role !== socket.data.role) socket.disconnect(true);
    }, () => socket.disconnect(true));
    socket.once('disconnect', () => {
        clearTimeout(expiryTimer);
        stopProfile();
    });

    // ── Get current warehouse base setting ──
    socket.on("get_warehouse_base", async (ack) => {
        try {
            const baseConfig = await getWarehouseBaseConfig();
            if (typeof ack === "function") {
                ack({success: true, data: baseConfig});
            } else {
                socket.emit("warehouse_base_data", baseConfig);
            }
        } catch (err) {
            console.error("[get_warehouse_base] error:", err.message);
            if (typeof ack === "function") ack({success: false, message: err.message});
        }
    });

    // ── Save warehouse base location & radius (super_admin only) ──
    socket.on("save_warehouse_base", async (data, ack) => {
        try {
            console.log("[save_warehouse_base] Received request from uid:", socket.data.uid, data);
            const userDoc = await admin.firestore().collection("users").doc(socket.data.uid).get();
            const userData = userDoc.data();

            if (!userData || userData.role !== "super_admin") {
                console.warn("[save_warehouse_base] Forbidden attempt by non-super_admin:", socket.data.uid, userData?.role);
                const res = {success: false, message: "Forbidden: Only super_admin can configure warehouse base location."};
                if (typeof ack === "function") ack(res);
                return socket.emit("warehouse_base_error", res);
            }

            const saved = await saveWarehouseBaseConfig(data, socket.data.uid, userData.email || userData.name);
            console.log("[save_warehouse_base] Successfully saved warehouse base:", saved);

            // Broadcast to all connected clients
            io.emit("warehouse_base_updated", saved);

            if (typeof ack === "function") {
                ack({success: true, data: saved});
            }
        } catch (err) {
            console.error("[save_warehouse_base] error:", err.message);
            const res = {success: false, message: err.message || "Failed to save warehouse base."};
            if (typeof ack === "function") ack(res);
            socket.emit("warehouse_base_error", res);
        }
    });

    // ── Get role change requests via Socket.IO ──
    socket.on("get_role_requests", async (params, ack) => {
        try {
            const status = (typeof params === "string" ? params : params?.status) || "all";
            const requests = await getRoleRequests(status, socket.data.uid);
            if (typeof ack === "function") ack({success: true, data: requests});
            else socket.emit("role_requests_data", requests);
        } catch (err) {
            console.error("[get_role_requests] error:", err.message);
            if (typeof ack === "function") ack({success: false, message: err.message});
        }
    });

    // ── Submit a role change request via Socket.IO ──
    socket.on("create_role_request", async (data, ack) => {
        try {
            const userDoc = await admin.firestore().collection("users").doc(socket.data.uid).get();
            const userData = userDoc.data();
            const created = await createRoleRequest({
                requesterId: socket.data.uid,
                requesterName: userData?.displayName || userData?.name || "User",
                requesterEmail: userData?.email || "",
                currentRole: userData?.role || "viewer",
                requestedRole: data.requestedRole,
            });
            if (typeof ack === "function") ack({success: true, data: created});
        } catch (err) {
            console.error("[create_role_request] error:", err.message);
            if (typeof ack === "function") ack({success: false, message: err.message});
        }
    });

    // ── Approve role request via Socket.IO (admin/super_admin only) ──
    socket.on("approve_role_request", async (data, ack) => {
        try {
            const userDoc = await admin.firestore().collection("users").doc(socket.data.uid).get();
            const userData = userDoc.data();
            if (!userData || (userData.role !== "super_admin" && userData.role !== "admin")) {
                const res = {success: false, message: "Forbidden: Admin privileges required."};
                if (typeof ack === "function") ack(res);
                return;
            }
            const approved = await approveRoleRequest(data.requestId, socket.data.uid);
            if (typeof ack === "function") ack({success: true, data: approved});
        } catch (err) {
            console.error("[approve_role_request] error:", err.message);
            if (typeof ack === "function") ack({success: false, message: err.message});
        }
    });

    // ── Reject role request via Socket.IO (admin/super_admin only) ──
    socket.on("reject_role_request", async (data, ack) => {
        try {
            const userDoc = await admin.firestore().collection("users").doc(socket.data.uid).get();
            const userData = userDoc.data();
            if (!userData || (userData.role !== "super_admin" && userData.role !== "admin")) {
                const res = {success: false, message: "Forbidden: Admin privileges required."};
                if (typeof ack === "function") ack(res);
                return;
            }
            const rejected = await rejectRoleRequest(data.requestId, socket.data.uid, data.reason);
            if (typeof ack === "function") ack({success: true, data: rejected});
        } catch (err) {
            console.error("[reject_role_request] error:", err.message);
            if (typeof ack === "function") ack({success: false, message: err.message});
        }
    });

    // ── Driver Full Capacity Toggle via Socket.IO ──
    socket.on("driver_is_full", async (data) => {
        try {
            if (socket.data.role !== 'driver' || !data || typeof data.isFull !== 'boolean'
                || (data.driverId && data.driverId !== socket.data.uid)) return;
            const driverId = data?.driverId || socket.data.uid;
            const isFull = Boolean(data?.isFull);
            const {updateDriverCapacity} = require('./services/driverCapacity');
            await updateDriverCapacity(driverId, isFull);

            // Broadcast to dispatchers
            io.to('dispatchers').emit("driver_capacity_updated", {driverId, isFull});
        } catch (err) {
            console.error(JSON.stringify({event:'capacity_update_failed', statusCode:err.statusCode || 500}));
        }
    });

    socket.on("driver_moving", (data) => {
        if (socket.data.role !== 'driver' || !data || data.driverId !== socket.data.uid
            || !Number.isFinite(data.lat) || !Number.isFinite(data.lng)
            || Math.abs(data.lat) > 90 || Math.abs(data.lng) > 180) return;
        if (data.driverId !== socket.data.uid) {
            console.warn("[driver_moving] ✗ REJECTED — driverId mismatch:", data.driverId, "!=", socket.data.uid);
            return;
        }
        io.to('dispatchers').emit("update_admin_map", {driverId: socket.data.uid, lat: data.lat, lng: data.lng,
            timestamp: Number.isFinite(data.timestamp) ? data.timestamp : Date.now()});

        // ── Persist lastLocation to sap_assignments so the dispatcher can
        //    render the marker even when the driver app has just reconnected
        //    (or briefly stopped emitting). We find the active dispatch for
        //    this driver (in_transit / loaded / loading) and write
        //    {lat, lng, at}.
        const {lat, lng} = data;
        if (typeof lat !== "number" || typeof lng !== "number") {
            console.log("[driver_moving] (skip persist: invalid coords)");
            return;
        }

        // Smart Movement Check: Throttle Firestore write to once every 10 mins AND >=100m moved
        const now = Date.now();
        const lastRecord = lastDriverLocationPersist.get(data.driverId);
        if (lastRecord?.inFlight || (lastRecord?.attemptAt != null && now - lastRecord.attemptAt < 30000)) return;
        if (lastRecord?.time != null) {
            // Must be at least 10 minutes since last Firestore write
            if (now - lastRecord.time < LOCATION_PERSIST_THROTTLE_MS) {
                return;
            }
            // Must have moved at least 100 meters (skip if parked or stuck in traffic)
            const distance = getDistanceMeters(lastRecord.lat, lastRecord.lng, lat, lng);
            if (distance < MIN_PERSIST_DISTANCE_METERS) {
                return;
            }
        }

        // Reserve before querying so concurrent events and failed attempts stay bounded.
        const attempt = {...lastRecord, attemptAt: now, inFlight: true};
        lastDriverLocationPersist.set(data.driverId, attempt);
        const db = admin.firestore();
        db.collection("sap_assignments")
            .where("driverId", "==", data.driverId)
            .where("tripStatus", "in", ["assigned", "loading", "loaded", "fully_loaded", "in_transit"])
            .limit(100)
            .get()
            .then((snap) => {
                if (snap.empty) {
                    console.log("[driver_moving] (skip persist: no active dispatch for driver)");
                    return null;
                }
                return Promise.all(snap.docs.map(doc => doc.ref
                    .set(
                        {
                            lastLocation: {
                                lat,
                                lng,
                                at: admin.firestore.FieldValue.serverTimestamp(),
                            },
                        },
                        {merge: true},
                    )
                    .then(() => doc.id)));
            })
            .then((updatedId) => {
                if (updatedId) {
                    Object.assign(attempt, {time: now, lat, lng});
                    console.log("[driver_moving] ✓ persisted lastLocation to", updatedId);
                }
            })
            .catch((err) => {
                console.error("[driver_moving] ✗ persist error:", err?.message ?? err);
            })
            .finally(() => { attempt.inFlight = false; });
    });

    // ── Driver Status Updates (completed / stopped / offline / online) ──
    socket.on("update_status", (data) => {
        try {
            if (socket.data.role !== 'driver' || !data || (data.driverId && data.driverId !== socket.data.uid)
                || !['stopped', 'offline', 'online'].includes(data.status)) return;
            const driverId = data?.driverId || socket.data.uid;
            const status = data?.status;
            if (!driverId || !status) return;

            // Broadcast to dispatchers / admin map for immediate UI reaction
            io.to('dispatchers').emit("update_status", {driverId, status, timestamp: Date.now()});

            if (status === "stopped") {
                io.to('dispatchers').emit("driver_stopped", {driverId});
            }
        } catch (err) {
            console.error("[update_status] error:", err.message);
        }
    });

    // ── Driver Stopped (traffic signal / idle) ──
    socket.on("driver_stopped", (data) => {
        try {
            if (socket.data.role !== 'driver' || !data || (data.driverId && data.driverId !== socket.data.uid)) return;
            const driverId = data?.driverId || socket.data.uid;
            io.to('dispatchers').emit("driver_stopped", {driverId});
            io.to('dispatchers').emit("update_status", {driverId, status: "stopped"});
        } catch (err) {
            console.error("[driver_stopped] error:", err.message);
        }
    });

    // ── Driver POD Updated (photo / signature uploaded) ──
    socket.on("pod_updated", async (data) => {
        try {
            if (socket.data.role !== 'driver' || !data || typeof data.shipmentDocId !== 'string'
                || !data.shipmentDocId.length || data.shipmentDocId.length > 128 || data.shipmentDocId.includes('/')) return;
            const assignment = await admin.firestore().collection('sap_assignments').doc(data.shipmentDocId).get();
            if (!assignment.exists || assignment.data().driverId !== socket.data.uid) return;
            io.to('dispatchers').to(`user:${socket.data.uid}`).emit('pod_updated', {
                shipmentDocId: data.shipmentDocId, driverId: socket.data.uid, source: 'driver_app',
            });
        } catch (err) {
            console.error("[pod_updated] error:", err.message);
        }
    });
});

server.listen(port, "0.0.0.0", () => {
    console.log(`🚀 SYSU SERVER RUNNING ON PORT ${port}`);
    startCleanupScheduler();
    startQueueCleanup();
    startIncidentCleanup();
    console.log("Cleanup schedulers started: QR tokens, queue, incidents");
});
