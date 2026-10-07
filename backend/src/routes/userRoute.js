const express = require("express");
const router = express.Router();
const {protectRoute} = require("../middleware/protectRoute.js");
const {authorize} = require("../middleware/authorize.js");
const {updateUserRole, deleteUser} = require("../controllers/userController.js");

router.post("/update-role", protectRoute, authorize(["admin", "super_admin"]), updateUserRole);
router.post("/delete", protectRoute, authorize(["super_admin"]), deleteUser);

module.exports = router;
