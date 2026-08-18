const {admin} = require("../../config/firebase.js");

const SETTINGS_COLLECTION = "settings";
const WAREHOUSE_DOC_ID = "warehouse_base";

// Default coordinates (SYSU warehouse / Manila area default)
const DEFAULT_BASE = {
    name: "SYSU Main Warehouse",
    address: "SYSU International, Quezon City, Metro Manila",
    lat: 14.6349,
    lng: 121.0392,
    radiusMeters: 500, // 500 meters default radius
    updatedAt: new Date().toISOString(),
    updatedBy: "system",
};

/**
 * Validate warehouse base location payload
 */
function validateWarehouseBasePayload(body) {
    const errors = [];
    const {lat, lng, radiusMeters, name, address} = body || {};

    const numLat = typeof lat === "number" ? lat : parseFloat(lat);
    const numLng = typeof lng === "number" ? lng : parseFloat(lng);
    const numRadius = typeof radiusMeters === "number" ? radiusMeters : parseFloat(radiusMeters);

    if (isNaN(numLat) || numLat < -90 || numLat > 90) {
        errors.push({field: "lat", message: "Latitude must be a valid number between -90 and 90"});
    }

    if (isNaN(numLng) || numLng < -180 || numLng > 180) {
        errors.push({field: "lng", message: "Longitude must be a valid number between -180 and 180"});
    }

    if (isNaN(numRadius) || numRadius < 10 || numRadius > 50000) {
        errors.push({field: "radiusMeters", message: "Radius must be between 10 meters and 50,000 meters"});
    }

    return {
        errors,
        lat: numLat,
        lng: numLng,
        radiusMeters: numRadius,
        name: typeof name === "string" ? name.trim().slice(0, 100) : "SYSU Main Warehouse",
        address: typeof address === "string" ? address.trim().slice(0, 250) : "",
    };
}

/**
 * Get the current warehouse base location configuration
 */
async function getWarehouseBaseConfig() {
    try {
        const docSnap = await admin.firestore().collection(SETTINGS_COLLECTION).doc(WAREHOUSE_DOC_ID).get();
        if (!docSnap.exists) {
            return DEFAULT_BASE;
        }
        return {id: docSnap.id, ...docSnap.data()};
    } catch (err) {
        console.error("getWarehouseBaseConfig error:", err);
        return DEFAULT_BASE;
    }
}

/**
 * Save warehouse base location to Firestore (helper used by both socket and REST)
 */
async function saveWarehouseBaseConfig(payload, userUid, userEmail) {
    const validated = validateWarehouseBasePayload(payload);
    if (validated.errors.length > 0) {
        const err = new Error(validated.errors.map(e => e.message).join(", "));
        err.errors = validated.errors;
        throw err;
    }

    const dataToSave = {
        name: validated.name,
        address: validated.address,
        lat: validated.lat,
        lng: validated.lng,
        radiusMeters: validated.radiusMeters,
        updatedAt: new Date().toISOString(),
        updatedBy: userEmail || userUid || "admin",
        updatedByUid: userUid || null,
    };

    await admin.firestore().collection(SETTINGS_COLLECTION).doc(WAREHOUSE_DOC_ID).set(dataToSave, {merge: true});
    return {id: WAREHOUSE_DOC_ID, ...dataToSave};
}

/**
 * REST Endpoint: GET /api/admin/warehouse-base
 */
async function getWarehouseBase(req, res) {
    try {
        const data = await getWarehouseBaseConfig();
        return res.status(200).json({success: true, data});
    } catch (error) {
        console.error("getWarehouseBase error:", error.message);
        return res.status(500).json({success: false, message: "Internal server error"});
    }
}

/**
 * REST Endpoint: PUT/POST /api/admin/warehouse-base
 */
async function updateWarehouseBase(req, res) {
    try {
        const userDoc = await admin.firestore().collection("users").doc(req.user.uid).get();
        const userData = userDoc.data();
        if (!userData || userData.role !== "super_admin") {
            return res.status(403).json({success: false, message: "Forbidden: Super Admin access required"});
        }

        const saved = await saveWarehouseBaseConfig(req.body, req.user.uid, req.user.email || userData.email);

        // Broadcast to all clients if socket.io is available
        if (global._io) {
            global._io.emit("warehouse_base_updated", saved);
        }

        return res.status(200).json({success: true, data: saved});
    } catch (error) {
        console.error("updateWarehouseBase error:", error.message);
        return res.status(400).json({success: false, message: error.message, errors: error.errors});
    }
}

module.exports = {
    DEFAULT_BASE,
    validateWarehouseBasePayload,
    getWarehouseBaseConfig,
    saveWarehouseBaseConfig,
    getWarehouseBase,
    updateWarehouseBase,
};
