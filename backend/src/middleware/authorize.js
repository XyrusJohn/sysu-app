const { admin } = require("../config/firebase.js");

/**
 * authorize
 * Middleware to restrict access to specific roles.
 * @param {string[]} allowedRoles - Array of roles permitted to access the route.
 */
const authorize = (allowedRoles = []) => {
    return async (req, res, next) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Not authorized, no user context found" });
            }

            const currentUserId = req.user.uid;
            const userDoc = await admin.firestore().collection("users").doc(currentUserId).get();
            const userData = userDoc.data();

            if (!userData || userData.status === 'inactive' || userData.status === 'disabled' || !allowedRoles.includes(userData.role)) {
                return res.status(403).json({
                    message: `Forbidden: Access restricted to ${allowedRoles.join(", ")} roles`
                });
            }

            // Attach userData to request to avoid re-fetching in controllers
            req.userData = userData;
            next();
        } catch (error) {
            console.error("Authorization error:", error.message);
            res.status(500).json({ message: "Internal server error during authorization" });
        }
    };
};

module.exports = { authorize };
