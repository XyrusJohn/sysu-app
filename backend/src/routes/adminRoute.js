const express = require("express");
const router = express.Router();
const {protectRoute} = require("../middleware/protectRoute.js");
const {requireAdmin} = require("../middleware/requireAdmin.js");
const {
    createGuard,
    updateGuard,
    setGuardActive,
} = require("../controllers/admin/guardController.js");
const {
    createTruckCompany,
    updateTruckCompany,
    setTruckCompanyActive,
} = require("../controllers/admin/truckCompanyController.js");

router.post("/guards", protectRoute, requireAdmin, createGuard);
router.patch("/guards/:id", protectRoute, requireAdmin, updateGuard);
router.patch("/guards/:id/active", protectRoute, requireAdmin, setGuardActive);
router.post("/truck-companies", protectRoute, requireAdmin, createTruckCompany);
router.patch("/truck-companies/:code", protectRoute, requireAdmin, updateTruckCompany);
router.patch("/truck-companies/:code/active", protectRoute, requireAdmin, setTruckCompanyActive);

module.exports = router;
