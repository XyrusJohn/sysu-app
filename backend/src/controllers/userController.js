const {admin} = require("../config/firebase.js");

const VALID_ROLES = ["admin", "driver", "fleet_manager", "pending", "super_admin", "qr_generator"];

exports.updateUserRole = async (req, res) => {
    try {
        const {uid, role} = req.body;
        const currentUserId = req.user.uid;

        if (!uid || !role) {
            return res.status(400).json({message: "uid and role are required"});
        }

        if (!VALID_ROLES.includes(role)) {
            return res.status(400).json({
                message: `Invalid role. Allowed values: ${VALID_ROLES.join(", ")}`,
            });
        }

        // 1. Verify current user exists and is authorized
        const currentUserDoc = await admin.firestore().collection("users").doc(currentUserId).get();
        const currentUserData = currentUserDoc.data();

        if (!currentUserData || (currentUserData.role !== "super_admin" && currentUserData.role !== "admin")) {
            return res.status(403).json({message: "Forbidden: Insufficient permissions to change roles"});
        }

        // 2. Prevent non-super-admins from promoting users to super_admin
        if (role === "super_admin" && currentUserData.role !== "super_admin") {
            return res.status(403).json({message: "Forbidden: Only super-admins can assign the super_admin role"});
        }

        // 3. Update the target user
        let position = "User";
        if (role === "admin") position = "Admin";
        if (role === "driver") position = "Driver";
        if (role === "fleet_manager") position = "Fleet Manager";
        if (role === "super_admin") position = "Super Admin";
        if (role === "pending") position = "Pending Approval";
        if (role === "qr_generator") position = "QR Generator";

        const status = role === "pending" ? "inactive" : "active";

        await admin.firestore().collection("users").doc(uid).update({
            role: role,
            status: status,
            position: position,
            forceRefresh: Date.now(),
        });

        res.json({success: true, message: "User role updated successfully"});
    } catch (error) {
        console.error("updateUserRole error:", error.message);
        res.status(500).json({success: false, error: "Internal server error"});
    }
};

exports.deleteUser = async (req, res) => {
    try {
        const {uid} = req.body;
        const currentUserId = req.user.uid;

        if (!uid) {
            return res.status(400).json({message: "uid is required"});
        }

        if (uid === currentUserId) {
            return res.status(400).json({message: "Cannot delete your own account"});
        }

        const currentUserDoc = await admin.firestore().collection("users").doc(currentUserId).get();
        const currentUserData = currentUserDoc.data();

        if (!currentUserData || currentUserData.role !== "super_admin") {
            return res.status(403).json({message: "Forbidden: Only super-admins can delete users"});
        }

        // Delete from Firebase Auth if exists
        try {
            await admin.auth().deleteUser(uid);
        } catch (authErr) {
            // User might not exist in Auth (e.g. legacy/mock document), continue to delete Firestore doc
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
    } catch (error) {
        console.error("deleteUser error:", error.message);
        res.status(500).json({success: false, error: "Internal server error"});
    }
};
