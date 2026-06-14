const express = require("express");
const router = express.Router();
const qrController = require("../controllers/qrController");
const {protectRoute} = require("../middleware/protectRoute.js");

// generate is public (command center QR display page has no auth)
// verify is public (read-only token status check)
// scan and queue-status require authentication
router.get("/generate", qrController.generateToken);
router.get("/verify", qrController.verifyToken);
router.post("/scan", protectRoute, qrController.scanToken);
router.patch("/queue-status", protectRoute, qrController.updateQueueStatus);

module.exports = router;
