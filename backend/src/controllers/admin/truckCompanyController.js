const {admin} = require("../../config/firebase.js");
const {asyncWrapper} = require("../../middleware/asyncWrapper.js");
const { z } = require("zod");
const {
    pickNextIdFromList,
    formatCompanyCode,
    parseCompanyCode,
} = require("../../utils/idGenerator.js");

const FORWARDER_CODE_MAX = 50;
const NAME_MAX = 200;
const FORWARDER_CODE_PATTERN = /^[A-Za-z0-9-]+$/;

const companySchema = z.object({
    forwarderCode: z.string().trim().min(1).max(FORWARDER_CODE_MAX).regex(FORWARDER_CODE_PATTERN, "forwarderCode may only contain letters, digits, and hyphens"),
    name: z.string().trim().min(1).max(NAME_MAX),
});

exports.createTruckCompany = asyncWrapper(async (req, res) => {
    const {forwarderCode, name} = companySchema.parse(req.body);

    const snapshot = await admin.firestore().collection("truck_company").get();
    const existingIds = snapshot.docs.map((doc) => doc.id);
    const companyCode = pickNextIdFromList(existingIds, formatCompanyCode, parseCompanyCode);

    const doc = {
        companyCode,
        forwarderCode,
        name,
        active: true,
        createdAt: new Date().toISOString(),
    };

    await admin.firestore().collection("truck_company").doc(companyCode).set(doc);

    return res.status(201).json({id: companyCode, ...doc});
});

exports.updateTruckCompany = asyncWrapper(async (req, res) => {
    const {code} = req.params;
    if (!parseCompanyCode(code)) {
        return res.status(400).json({errors: [{field: "code", message: "Invalid companyCode"}]});
    }

    const docRef = admin.firestore().collection("truck_company").doc(code);
    const existing = await docRef.get();
    if (!existing.exists) {
        return res.status(404).json({message: "Truck company not found"});
    }

    const existingData = existing.data();
    const updates = req.body;

    const normalized = companySchema.parse({
        forwarderCode: updates.forwarderCode !== undefined ? updates.forwarderCode : existingData.forwarderCode,
        name: updates.name !== undefined ? updates.name : existingData.name,
    });

    const patch = {
        forwarderCode: normalized.forwarderCode,
        name: normalized.name,
        updatedAt: new Date().toISOString(),
    };

    await docRef.update(patch);

    const refreshed = await docRef.get();
    return res.status(200).json({id: refreshed.id, ...refreshed.data()});
});

exports.setTruckCompanyActive = asyncWrapper(async (req, res) => {
    const {code} = req.params;
    if (!parseCompanyCode(code)) {
        return res.status(400).json({errors: [{field: "code", message: "Invalid companyCode"}]});
    }

    const docRef = admin.firestore().collection("truck_company").doc(code);
    const existing = await docRef.get();
    if (!existing.exists) {
        return res.status(404).json({message: "Truck company not found"});
    }

    const activeSchema = z.object({
        active: z.boolean(),
    });

    const {active} = activeSchema.parse(req.body);

    await docRef.update({
        active,
        updatedAt: new Date().toISOString(),
    });

    const refreshed = await docRef.get();
    return res.status(200).json({id: refreshed.id, ...refreshed.data()});
});
