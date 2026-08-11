const express = require("express");
const {Server} = require("socket.io");
const http = require("http");
const {initializeFirebase, admin} = require("./config/firebase");
const dotenv = require("dotenv");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("node-cron");

dotenv.config();

// ── Strict env var parsing — reject malformed values instead of auto-repair ──
const rawPort = process.env.PORT;
if (!rawPort || !/^\d+$/.test(rawPort)) {
    if (rawPort) console.error(`[server] Invalid PORT env: "${rawPort}". Defaulting to 8080.`);
    process.env.PORT = "8080";
}
const port = parseInt(process.env.PORT, 10);

// TRUST_PROXY: must be "0", "1", or a valid IP address — no silent override
const rawTrustProxy = process.env.TRUST_PROXY;
const validProxyValues = ["0", "1"];
const IP_RE = /^\d+\.\d+\.\d+\.\d+$/;
if (!validProxyValues.includes(rawTrustProxy) && !IP_RE.test(rawTrustProxy || "")) {
    if (rawTrustProxy) console.error(`[server] Invalid TRUST_PROXY env: "${rawTrustProxy}". Defaulting to 0.`);
    process.env.TRUST_PROXY = "0"; // safe default — no IP spoofing
}

initializeFirebase();

const authRoutes = require("./routes/authRoute.js");
const sapRoutes = require("./routes/sapRoute.js");
const sapAssignmentRoutes = require("./routes/sapAssignmentRoute.js");
const userRoutes = require("./routes/userRoute.js");
const qrRoutes = require("./routes/qrRoute.js");
const driverRoutes = require("./routes/driverRoute.js");
const adminRoutes = require("./routes/adminRoute.js");
const { startCleanupScheduler } = require("./utils/qrTokenCleanup");
const { startCleanupScheduler: startQueueCleanup } = require("./utils/queueCleanup");
const { startCleanupScheduler: startIncidentCleanup } = require("./utils/incidentCleanup");

const app = express();
app.use(helmet({contentSecurityPolicy: false}));

// ── Rate limiting ──
app.set("trust proxy", parseInt(process.env.TRUST_PROXY, 10));

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
});
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(globalLimiter);
app.use("/api/auth", authLimiter);
app.use("/api/users", authLimiter);

const allowedOrigins = [
    "https://sysu-web-5a25d.web.app",
    "https://sysu-web-5a25d.firebaseapp.com",
    "https://sysu-app-production.up.railway.app",
    "http://localhost:5173",
    "http://localhost:5174",
];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    const isAllowed = origin && allowedOrigins.includes(origin);

    // OPTIONS requests must also pass origin check
    if (req.method === "OPTIONS") {
        if (isAllowed) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE, PATCH");
            res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
        }
        return res.status(204).end();
    }

    if (isAllowed) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE, PATCH");
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    next();
});

app.use(express.json({limit: "10kb"}));
app.use("/api/auth", authRoutes);
app.use("/api/sap", sapRoutes);
app.use("/api/sap", sapAssignmentRoutes);
app.use("/api/users", userRoutes);
app.use("/api/qr", qrRoutes);
app.use("/api/drivers", driverRoutes);
app.use("/api/admin", adminRoutes);

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

/* ── io exported so controllers can emit events ── */
global._io = io;
global._qrNs = qrNs;

io.on("connection", async (socket) => {
    try {
        const token = socket.handshake.auth?.token;
        if (!token) return socket.disconnect("No token");
        const decoded = await require("firebase-admin").auth().verifyIdToken(token);
        socket.data.uid = decoded.uid;
    } catch {
        return socket.disconnect("Invalid token");
    }

    socket.on("driver_moving", (data) => {
        console.log("[driver_moving] ★ RECEIVED from socket:", JSON.stringify(data));
        if (data.driverId !== socket.data.uid) {
            console.warn("[driver_moving] ✗ REJECTED — driverId mismatch:", data.driverId, "!=", socket.data.uid);
            return;
        }
        console.log("[driver_moving] ✓ broadcasting update_admin_map to all clients");
        io.emit("update_admin_map", data);

        // ── Persist lastLocation to sap_assignments so the dispatcher can
        //    render the marker even when the driver app has just reconnected
        //    (or briefly stopped emitting). We find the active dispatch for
        //    this driver (in_transit / loaded / loading) and write
        //    {lat, lng, at}.
        const {lat, lng} = data;
        if (typeof lat !== "number" || typeof lng !== "number" || lat === 0 || lng === 0) {
            console.log("[driver_moving] (skip persist: invalid coords)");
            return;
        }
        const db = admin.firestore();
        db.collection("sap_assignments")
            .where("driverId", "==", data.driverId)
            .where("tripStatus", "in", ["loaded", "in_transit", "loading"])
            .limit(1)
            .get()
            .then((snap) => {
                if (snap.empty) {
                    console.log("[driver_moving] (skip persist: no active dispatch for driver)");
                    return null;
                }
                const doc = snap.docs[0];
                return doc.ref
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
                    .then(() => doc.id);
            })
            .then((updatedId) => {
                if (updatedId) {
                    console.log("[driver_moving] ✓ persisted lastLocation to", updatedId);
                }
            })
            .catch((err) => {
                console.error("[driver_moving] ✗ persist error:", err?.message ?? err);
            });
    });
});

server.listen(port, "0.0.0.0", () => {
    console.log(`🚀 SYSU SERVER RUNNING ON PORT ${port}`);
    startCleanupScheduler();
    startQueueCleanup();
    startIncidentCleanup();
    console.log("Cleanup schedulers started: QR tokens, queue, incidents");
});