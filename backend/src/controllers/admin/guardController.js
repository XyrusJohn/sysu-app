const {admin} = require("../../config/firebase.js");
const {
    pickNextIdFromList,
    formatGuardId,
    parseGuardId,
} = require("../../utils/idGenerator.js");

const FIRST_NAME_MAX = 60;
const LAST_NAME_MAX = 60;
const MIDDLE_INITIAL_MAX = 5;

function validateGuardPayload(body) {
    const errors = [];
    const rawFirstName = body && body.firstName;
    const rawLastName = body && body.lastName;
    const rawMiddleInitial = body ? body.middleInitial : undefined;

    const firstName = typeof rawFirstName === "string" ? rawFirstName.trim() : "";
    const lastName = typeof rawLastName === "string" ? rawLastName.trim() : "";
    const middleInitialProvided = rawMiddleInitial !== undefined && rawMiddleInitial !== null;
    const middleInitial = typeof rawMiddleInitial === "string" ? rawMiddleInitial.trim() : "";

    if (!firstName) {
        errors.push({field: "firstName", message: "firstName is required"});
    } else if (firstName.length > FIRST_NAME_MAX) {
        errors.push({field: "firstName", message: `firstName must be ${FIRST_NAME_MAX} characters or fewer`});
    }

    if (!lastName) {
        errors.push({field: "lastName", message: "lastName is required"});
    } else if (lastName.length > LAST_NAME_MAX) {
        errors.push({field: "lastName", message: `lastName must be ${LAST_NAME_MAX} characters or fewer`});
    }

    if (middleInitialProvided && middleInitial.length > MIDDLE_INITIAL_MAX) {
        errors.push({
            field: "middleInitial",
            message: `middleInitial must be ${MIDDLE_INITIAL_MAX} characters or fewer`,
        });
    }

    return {
        errors,
        firstName,
        lastName,
        middleInitial: middleInitialProvided ? middleInitial : "",
    };
}

function buildFullName(firstName, lastName, middleInitial) {
    const safeFirst = (firstName || "").trim().replace(/\s+/g, " ");
    const safeLast = (lastName || "").trim().replace(/\s+/g, " ");
    const safeMiddle = (middleInitial || "").trim().replace(/\s+/g, " ");
    const middlePart = safeMiddle ? `${safeMiddle} ` : "";
    return `${safeFirst} ${middlePart}${safeLast}`.replace(/\s+/g, " ").trim();
}

exports.validateGuardPayload = validateGuardPayload;
exports.buildFullName = buildFullName;

exports.createGuard = async (req, res) => {
    try {
        const {errors, firstName, lastName, middleInitial} = validateGuardPayload(req.body);
        if (errors.length > 0) {
            return res.status(400).json({errors});
        }

        const snapshot = await admin.firestore().collection("security_guard").get();
        const existingIds = snapshot.docs.map((doc) => doc.id);
        const guardId = pickNextIdFromList(existingIds, formatGuardId, parseGuardId);

        const fullName = buildFullName(firstName, lastName, middleInitial);
        const doc = {
            guardId,
            firstName,
            lastName,
            middleInitial,
            fullName,
            active: true,
            createdAt: new Date().toISOString(),
        };

        await admin.firestore().collection("security_guard").doc(guardId).set(doc);

        return res.status(201).json({id: guardId, ...doc});
    } catch (error) {
        console.error("createGuard error:", error.message);
        return res.status(500).json({message: "Internal server error"});
    }
};

exports.updateGuard = async (req, res) => {
    try {
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

        const allowed = ["firstName", "lastName", "middleInitial"];
        const updates = {};
        if (req.body && typeof req.body === "object") {
            for (const key of allowed) {
                if (Object.prototype.hasOwnProperty.call(req.body, key)) {
                    updates[key] = req.body[key];
                }
            }
        }

        const normalized = validateGuardPayload({
            firstName: updates.firstName !== undefined ? updates.firstName : existingData.firstName,
            lastName: updates.lastName !== undefined ? updates.lastName : existingData.lastName,
            middleInitial:
                updates.middleInitial !== undefined ? updates.middleInitial : existingData.middleInitial,
        });

        if (normalized.errors.length > 0) {
            return res.status(400).json({errors: normalized.errors});
        }

        const nextFirstName =
            updates.firstName !== undefined ? normalized.firstName : existingData.firstName;
        const nextLastName =
            updates.lastName !== undefined ? normalized.lastName : existingData.lastName;
        const nextMiddleInitial =
            updates.middleInitial !== undefined ? normalized.middleInitial : existingData.middleInitial || "";

        const fullName = buildFullName(nextFirstName, nextLastName, nextMiddleInitial);

        const patch = {
            firstName: nextFirstName,
            lastName: nextLastName,
            middleInitial: nextMiddleInitial,
            fullName,
            updatedAt: new Date().toISOString(),
        };

        await docRef.update(patch);

        const refreshed = await docRef.get();
        return res.status(200).json({id: refreshed.id, ...refreshed.data()});
    } catch (error) {
        console.error("updateGuard error:", error.message);
        return res.status(500).json({message: "Internal server error"});
    }
};

exports.setGuardActive = async (req, res) => {
    try {
        const {id} = req.params;
        if (!parseGuardId(id)) {
            return res.status(400).json({errors: [{field: "id", message: "Invalid guardId"}]});
        }

        const docRef = admin.firestore().collection("security_guard").doc(id);
        const existing = await docRef.get();
        if (!existing.exists) {
            return res.status(404).json({message: "Guard not found"});
        }

        if (typeof req.body?.active !== "boolean") {
            return res.status(400).json({errors: [{field: "active", message: "active must be a boolean"}]});
        }
        const nextActive = req.body.active;

        await docRef.update({
            active: nextActive,
            updatedAt: new Date().toISOString(),
        });

        const refreshed = await docRef.get();
        return res.status(200).json({id: refreshed.id, ...refreshed.data()});
    } catch (error) {
        console.error("setGuardActive error:", error.message);
        return res.status(500).json({message: "Internal server error"});
    }
};
