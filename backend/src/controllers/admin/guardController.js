const {admin} = require("../../config/firebase.js");
const {asyncWrapper} = require("../../middleware/asyncWrapper.js");
const { z } = require("zod");
const {
    formatGuardId,
    parseGuardId,
} = require("../../utils/idGenerator.js");
const {createSequentialRecord, deleteSequentialRecord} = require('../../services/sequentialRecordService');

const FIRST_NAME_MAX = 60;
const LAST_NAME_MAX = 60;
const MIDDLE_INITIAL_MAX = 5;

const guardSchema = z.object({
    firstName: z.string().trim().min(1).max(FIRST_NAME_MAX),
    lastName: z.string().trim().min(1).max(LAST_NAME_MAX),
    middleInitial: z.string().trim().max(MIDDLE_INITIAL_MAX).optional().or(z.literal("")),
});

function buildFullName(firstName, lastName, middleInitial) {
    const safeFirst = (firstName || "").trim().replace(/\s+/g, " ");
    const safeLast = (lastName || "").trim().replace(/\s+/g, " ");
    const safeMiddle = (middleInitial || "").trim().replace(/\s+/g, " ");
    const middlePart = safeMiddle ? `${safeMiddle} ` : "";
    return `${safeFirst} ${middlePart}${safeLast}`.replace(/\s+/g, " ").trim();
}

exports.createGuard = asyncWrapper(async (req, res) => {
    const {firstName, lastName, middleInitial} = guardSchema.parse(req.body);

    const fullName = buildFullName(firstName, lastName, middleInitial);
    const record = await createSequentialRecord(admin.firestore(), 'security_guard', formatGuardId, parseGuardId, guardId => ({
        guardId,
        firstName,
        lastName,
        middleInitial: middleInitial || "",
        fullName,
        active: true,
        createdAt: new Date().toISOString(),
    }));
    return res.status(201).json(record);
});

exports.updateGuard = asyncWrapper(async (req, res) => {
    const {id} = req.params;
    if (!parseGuardId(id)) {
        return res.status(400).json({errors: [{field: "id", message: "Invalid guardId"}]});
    }

    const docRef = admin.firestore().collection("security_guard").doc(id);
    const existing = await docRef.get();
    if (!existing.exists) {
        return res.status(404).json({message: "Guard not found"});
    }

    const existingData = existing.data();
    const updates = req.body;

    const normalized = guardSchema.parse({
        firstName: updates.firstName !== undefined ? updates.firstName : existingData.firstName,
        lastName: updates.lastName !== undefined ? updates.lastName : existingData.lastName,
        middleInitial: updates.middleInitial !== undefined ? updates.middleInitial : existingData.middleInitial,
    });

    const fullName = buildFullName(normalized.firstName, normalized.lastName, normalized.middleInitial);

    const patch = {
        firstName: normalized.firstName,
        lastName: normalized.lastName,
        middleInitial: normalized.middleInitial || "",
        fullName,
        updatedAt: new Date().toISOString(),
    };

    await docRef.update(patch);

    const refreshed = await docRef.get();
    return res.status(200).json({id: refreshed.id, ...refreshed.data()});
});

exports.setGuardActive = asyncWrapper(async (req, res) => {
    const {id} = req.params;
    if (!parseGuardId(id)) {
        return res.status(400).json({errors: [{field: "id", message: "Invalid guardId"}]});
    }

    const docRef = admin.firestore().collection("security_guard").doc(id);
    const existing = await docRef.get();
    if (!existing.exists) {
        return res.status(404).json({message: "Guard not found"});
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

exports.deleteGuard = asyncWrapper(async (req, res) => {
    const {id} = req.params;
    if (!parseGuardId(id)) {
        return res.status(400).json({errors: [{field: "id", message: "Invalid guardId"}]});
    }

    const deleted = await deleteSequentialRecord(admin.firestore(), "security_guard", id, parseGuardId);
    if (!deleted) return res.status(404).json({message: "Guard not found"});
    return res.status(200).json({success: true, id});
});
