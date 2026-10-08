const {admin} = require("../../config/firebase.js");
const {asyncWrapper} = require("../../middleware/asyncWrapper.js");
const { z } = require("zod");

const SETTINGS_COLLECTION = "settings";
const WAREHOUSE_DOC_ID = "warehouse_base";

const DEFAULT_BASE = {
    name: "SYSU Main Warehouse",
    address: "SYSU International, Quezon City, Metro Manila",
    lat: 14.6349,
    lng: 121.0392,
    radiusMeters: 500,
    updatedAt: new Date().toISOString(),
    updatedBy: "system",
};

const warehouseSchema = z.object({
    lat: z.preprocess((val) => parseFloat(val), z.number().min(-90).max(90)),
    lng: z.preprocess((val) => parseFloat(val), z.number().min(-180).max(180)),
    radiusMeters: z.preprocess((val) => parseFloat(val), z.number().min(10).max(50000)),
    name: z.string().trim().max(100).default("SYSU Main Warehouse"),
    address: z.string().trim().max(250).default(""),
});

async function getWarehouseBaseConfig() {
    const docSnap = await admin.firestore().collection(SETTINGS_COLLECTION).doc(WAREHOUSE_DOC_ID).get();
    if (!docSnap.exists) {
        return DEFAULT_BASE;
    }
    return {id: docSnap.id, ...docSnap.data()};
}

async function saveWarehouseBaseConfig(payload, userUid, userEmail) {
    const validated = warehouseSchema.parse(payload);

    const dataToSave = {
        ...validated,
        updatedAt: new Date().toISOString(),
        updatedBy: userEmail || userUid || "admin",
        updatedByUid: userUid || null,
    };

    await admin.firestore().collection(SETTINGS_COLLECTION).doc(WAREHOUSE_DOC_ID).set(dataToSave, {merge: true});
    return {id: WAREHOUSE_DOC_ID, ...dataToSave};
}

exports.getWarehouseBaseConfig = getWarehouseBaseConfig;
exports.saveWarehouseBaseConfig = saveWarehouseBaseConfig;

exports.getWarehouseBase = asyncWrapper(async (req, res) => {
    const data = await getWarehouseBaseConfig();
    return res.status(200).json({success: true, data});
});

exports.updateWarehouseBase = asyncWrapper(async (req, res) => {
    const userDoc = await admin.firestore().collection("users").doc(req.user.uid).get();
    const userData = userDoc.data();
    if (!userData || userData.role !== "super_admin") {
        return res.status(403).json({success: false, message: "Forbidden: Super Admin access required"});
    }

    const saved = await saveWarehouseBaseConfig(req.body, req.user.uid, req.user.email || userData.email);

    if (global._io) {
        global._io.emit("warehouse_base_updated", saved);
    }

    return res.status(200).json({success: true, data: saved});
});
