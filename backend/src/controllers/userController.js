const {admin} = require("../config/firebase.js");
const {asyncWrapper} = require("../middleware/asyncWrapper.js");
const { z } = require("zod");

const VALID_ROLES = ["admin", "driver", "fleet_manager", "pending", "super_admin", "qr_generator"];

const updateRoleSchema = z.object({
    uid: z.string().min(1),
    role: z.enum(VALID_ROLES),
});

exports.updateUserRole = asyncWrapper(async (req, res) => {
    const { uid, role } = updateRoleSchema.parse(req.body);
    const currentUserId = req.user.uid;
    const currentUserData = req.userData;

    // 1. Prevent non-super-admins from promoting users to super_admin
    if (role === "super_admin" && currentUserData.role !== "super_admin") {
        return res.status(403).json({message: "Forbidden: Only super-admins can assign the super_admin role"});
    }

    // 2. Map role to display position
    const rolePositionMap = {
        admin: "Admin",
        driver: "Driver",
        fleet_manager: "Fleet Manager",
        super_admin: "Super Admin",
        pending: "Pending Approval",
        qr_generator: "QR Generator",
    };
    const position = rolePositionMap[role] || "User";
    const status = role === "pending" ? "inactive" : "active";

    await admin.firestore().collection("users").doc(uid).update({
        role: role,
        status: status,
        position: position,
        forceRefresh: Date.now(),
    });

    res.json({success: true, message: "User role updated successfully"});
});

exports.deleteUser = asyncWrapper(async (req, res) => {
    const { uid } = z.object({ uid: z.string().min(1) }).parse(req.body);
    const currentUserId = req.user.uid;

    if (uid === currentUserId) {
        return res.status(400).json({message: "Cannot delete your own account"});
    }

    // Delete from Firebase Auth if exists
    try {
        await admin.auth().deleteUser(uid);
    } catch (authErr) {
        console.warn("Auth delete warning (proceeding with Firestore delete):", authErr.message);
    }

    // Delete from Firestore (both users and drivers collections)
    await admin.firestore().collection("users").doc(uid).delete();
    await admin.firestore().collection("drivers").doc(uid).delete();

    // Broadcast real-time account deletion event to force immediate logout across all devices
    if (global._io) {
        global._io.emit("account_deleted", {uid});
    }

    res.json({success: true, message: "User deleted successfully"});
});
