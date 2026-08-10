const {admin} = require("../../config/firebase.js");
const {
    pickNextIdFromList,
    formatCompanyCode,
    parseCompanyCode,
} = require("../../utils/idGenerator.js");

const FORWARDER_CODE_MAX = 50;
const NAME_MAX = 200;
const FORWARDER_CODE_PATTERN = /^[A-Za-z0-9-]+$/;

function validateCompanyPayload(body) {
    const errors = [];
    const rawForwarderCode = body && body.forwarderCode;
    const rawName = body && body.name;

    const forwarderCode =
        typeof rawForwarderCode === "string" ? rawForwarderCode.trim() : "";
    const name = typeof rawName === "string" ? rawName.trim() : "";

    if (!forwarderCode) {
        errors.push({field: "forwarderCode", message: "forwarderCode is required"});
    } else if (forwarderCode.length > FORWARDER_CODE_MAX) {
        errors.push({
            field: "forwarderCode",
            message: `forwarderCode must be ${FORWARDER_CODE_MAX} characters or fewer`,
        });
    } else if (!FORWARDER_CODE_PATTERN.test(forwarderCode)) {
        errors.push({
            field: "forwarderCode",
            message: "forwarderCode may only contain letters, digits, and hyphens",
        });
    }

    if (!name) {
        errors.push({field: "name", message: "name is required"});
    } else if (name.length > NAME_MAX) {
        errors.push({
            field: "name",
            message: `name must be ${NAME_MAX} characters or fewer`,
        });
    }

    return {errors, forwarderCode, name};
}

exports.validateCompanyPayload = validateCompanyPayload;

exports.createTruckCompany = async (req, res) => {
    try {
        const {errors, forwarderCode, name} = validateCompanyPayload(req.body);
        if (errors.length > 0) {
            return res.status(400).json({errors});
        }

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
    } catch (error) {
        console.error("createTruckCompany error:", error.message);
        return res.status(500).json({message: "Internal server error"});
    }
};

exports.updateTruckCompany = async (req, res) => {
    try {
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

        const allowed = ["forwarderCode", "name"];
        const updates = {};
        if (req.body && typeof req.body === "object") {
            for (const key of allowed) {
                if (Object.prototype.hasOwnProperty.call(req.body, key)) {
                    updates[key] = req.body[key];
                }
            }
        }

        const normalized = validateCompanyPayload({
            forwarderCode: updates.forwarderCode !== undefined ? updates.forwarderCode : existingData.forwarderCode,
            name: updates.name !== undefined ? updates.name : existingData.name,
        });

        if (normalized.errors.length > 0) {
            return res.status(400).json({errors: normalized.errors});
        }

        const nextForwarderCode =
            updates.forwarderCode !== undefined ? normalized.forwarderCode : existingData.forwarderCode;
        const nextName =
            updates.name !== undefined ? normalized.name : existingData.name;

        const patch = {
            forwarderCode: nextForwarderCode,
            name: nextName,
            updatedAt: new Date().toISOString(),
        };

        await docRef.update(patch);

        const refreshed = await docRef.get();
        return res.status(200).json({id: refreshed.id, ...refreshed.data()});
    } catch (error) {
        console.error("updateTruckCompany error:", error.message);
        return res.status(500).json({message: "Internal server error"});
    }
};

exports.setTruckCompanyActive = async (req, res) => {
    try {
        const {code} = req.params;
        if (!parseCompanyCode(code)) {
            return res.status(400).json({errors: [{field: "code", message: "Invalid companyCode"}]});
        }

        const docRef = admin.firestore().collection("truck_company").doc(code);
        const existing = await docRef.get();
        if (!existing.exists) {
            return res.status(404).json({message: "Truck company not found"});
        }

        const currentActive = existing.data().active !== false;
        const nextActive = !currentActive;

        await docRef.update({
            active: nextActive,
            updatedAt: new Date().toISOString(),
        });

        const refreshed = await docRef.get();
        return res.status(200).json({id: refreshed.id, ...refreshed.data()});
    } catch (error) {
        console.error("setTruckCompanyActive error:", error.message);
        return res.status(500).json({message: "Internal server error"});
    }
};
