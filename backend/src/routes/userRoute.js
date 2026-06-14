const express = require("express");
const router = express.Router();
const {protectRoute} = require("../middleware/protectRoute.js");
const {updateUserRole, deleteUser} = require("../controllers/userController.js");

router.post("/update-role", protectRoute, updateUserRole);
router.post("/delete", protectRoute, deleteUser);

module.exports = router;
