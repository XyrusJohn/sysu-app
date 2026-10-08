const {admin} = require("../config/firebase.js");

const protectRoute = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.startsWith("Bearer ")
            ? authHeader.split(" ")[1]
            : req.cookies?.token;

        if (!token) {
            return res
                .status(401)
                .json({message: "Not authorized, no token provided"});
        }

        const decodedToken = await admin.auth().verifyIdToken(token, true);

        req.user = decodedToken;
        next();
    } catch (error) {
        console.error("Firebase Auth error:", error.message);
        res.status(401).json({message: "Not authorized, invalid or expired token"});
    }
};

module.exports = {protectRoute};
