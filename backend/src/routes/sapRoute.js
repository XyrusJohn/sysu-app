const express = require("express");
const router = express.Router();
const {getSapData} = require("../controller/sapController.js");
const {protectRoute} = require("../middleware/protectRoute.js");
const {authorize} = require("../middleware/authorize.js");

router.get("/shipments", protectRoute, authorize(["fleet_manager", "admin", "super_admin"]), getSapData);

module.exports = router;
