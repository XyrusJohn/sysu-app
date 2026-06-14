const express = require("express");
const router = express.Router();
const {getSapData} = require("../controller/sapController.js");
const {protectRoute} = require("../middleware/protectRoute.js");

router.get("/shipments", protectRoute, getSapData);

module.exports = router;
