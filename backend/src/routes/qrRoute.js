const express = require("express");
const router = express.Router();
const qrController = require("../controllers/qrController");
const {protectRoute} = require("../middleware/protectRoute.js");
const {authorize} = require("../middleware/authorize.js");

// generate is public (command center QR display page has no auth)
// verify is public (read-only token status check)
// scan and queue-status require authentication
router.get("/generate", qrController.generateToken);
router.get("/verify", qrController.verifyToken);
router.get('/queue-display', qrController.getPublicQueue);
router.post("/scan", protectRoute, authorize(["driver"]), qrController.scanToken);
router.patch("/queue-status", protectRoute, authorize(["admin", "super_admin"]), qrController.updateQueueStatus);

module.exports = router;
