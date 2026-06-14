const express = require("express");
const router = express.Router();
const {protectRoute} = require("../middleware/protectRoute.js");
const {
    getDriver,
    updateDriverFull,
} = require("../controllers/driverController.js");

// Read driver doc (public — used by both app and web for sync)
router.get("/:driverId", getDriver);

// Declare truck full / available again — authenticated (driver only)
router.patch("/:driverId/full", protectRoute, updateDriverFull);

module.exports = router;