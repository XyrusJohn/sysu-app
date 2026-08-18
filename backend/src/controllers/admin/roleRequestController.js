const {admin} = require("../../config/firebase.js");

/**
 * Get all role requests or pending ones
 */
async function getRoleRequests(status = "pending") {
    const db = admin.firestore();
    let query = db.collection("role_requests");
    if (status && status !== "all") {
        query = query.where("status", "==", status);
    }
    const snap = await query.get();
    const list = [];
    snap.forEach((doc) => {
        const data = doc.data();
        list.push({
            id: doc.id,
            ...data,
            createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt || new Date().toISOString(),
        });
    });
    // Sort newest first
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return list;
}

/**
 * Create a new role request
 */
async function createRoleRequest({requesterId, requesterName, requesterEmail, currentRole, requestedRole}) {
    const db = admin.firestore();
    const docRef = db.collection("role_requests").doc();
    const newRequest = {
        id: docRef.id,
        requesterId,
        requesterName: requesterName || "User",
        requesterEmail: requesterEmail || "",
        currentRole: currentRole || "viewer",
        requestedRole,
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await docRef.set(newRequest);

    // Also mark pendingRoleChange on the user document
    await db.collection("users").doc(requesterId).update({
        pendingRoleChange: requestedRole,
    });

    const created = {
        ...newRequest,
        createdAt: new Date().toISOString(),
    };

    // Emit real-time event via Socket.IO if global._io exists
    if (global._io) {
        global._io.emit("role_request_created", created);
    }

    return created;
}

/**
 * Approve a role change request
 */
async function approveRoleRequest(requestId, reviewerId) {
    const db = admin.firestore();
    const reqDoc = await db.collection("role_requests").doc(requestId).get();
    if (!reqDoc.exists) {
        throw new Error("Role request not found");
    }

    const data = reqDoc.data();
    if (data.status !== "pending") {
        throw new Error(`Request is already ${data.status}`);
    }

    const {requesterId, requestedRole} = data;

    let position = "User";
    if (requestedRole === "admin") position = "Admin";
    if (requestedRole === "driver") position = "Driver";
    if (requestedRole === "fleet_manager") position = "Fleet Manager";
    if (requestedRole === "super_admin") position = "Super Admin";
    if (requestedRole === "pending") position = "Pending Approval";
    if (requestedRole === "qr_generator") position = "QR Generator";

    const status = requestedRole === "pending" ? "inactive" : "active";

    // Update user
    await db.collection("users").doc(requesterId).update({
        role: requestedRole,
        status: status,
        position: position,
        pendingRoleChange: null,
        forceRefresh: Date.now(),
    });

    // Update role request status
    await db.collection("role_requests").doc(requestId).update({
        status: "approved",
        reviewerId: reviewerId || null,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const result = {
        id: requestId,
        requesterId,
        requestedRole,
        status: "approved",
        reviewedAt: new Date().toISOString(),
    };

    if (global._io) {
        global._io.emit("role_request_updated", result);
        global._io.emit("user_role_changed", {uid: requesterId, role: requestedRole});
    }

    return result;
}

/**
 * Reject a role change request
 */
async function rejectRoleRequest(requestId, reviewerId, reason = "") {
    const db = admin.firestore();
    const reqDoc = await db.collection("role_requests").doc(requestId).get();
    if (!reqDoc.exists) {
        throw new Error("Role request not found");
    }

    const data = reqDoc.data();
    const {requesterId} = data;

    // Clear pendingRoleChange on user
    await db.collection("users").doc(requesterId).update({
        pendingRoleChange: null,
    });

    // Update request
    await db.collection("role_requests").doc(requestId).update({
        status: "rejected",
        rejectionReason: reason || null,
        reviewerId: reviewerId || null,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const result = {
        id: requestId,
        requesterId,
        status: "rejected",
        rejectionReason: reason || null,
        reviewedAt: new Date().toISOString(),
    };

    if (global._io) {
        global._io.emit("role_request_updated", result);
    }

    return result;
}

module.exports = {
    getRoleRequests,
    createRoleRequest,
    approveRoleRequest,
    rejectRoleRequest,
};
