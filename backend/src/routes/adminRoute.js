const express = require("express");
const router = express.Router();
const {protectRoute} = require("../middleware/protectRoute.js");
const {requireAdmin} = require("../middleware/requireAdmin.js");
const {
    createGuard,
    updateGuard,
    setGuardActive,
    deleteGuard,
} = require("../controllers/admin/guardController.js");
const {
    createTruckCompany,
    updateTruckCompany,
    setTruckCompanyActive,
    deleteTruckCompany,
} = require("../controllers/admin/truckCompanyController.js");
const {
    getWarehouseBase,
    updateWarehouseBase,
} = require("../controllers/admin/warehouseBaseController.js");

router.post("/guards", protectRoute, requireAdmin, createGuard);
router.patch("/guards/:id", protectRoute, requireAdmin, updateGuard);
router.patch("/guards/:id/active", protectRoute, requireAdmin, setGuardActive);
router.delete("/guards/:id", protectRoute, requireAdmin, deleteGuard);
router.post("/truck-companies", protectRoute, requireAdmin, createTruckCompany);
router.patch("/truck-companies/:code", protectRoute, requireAdmin, updateTruckCompany);
router.patch("/truck-companies/:code/active", protectRoute, requireAdmin, setTruckCompanyActive);
router.delete("/truck-companies/:code", protectRoute, requireAdmin, deleteTruckCompany);
router.get("/warehouse-base", protectRoute, getWarehouseBase);
router.put("/warehouse-base", protectRoute, requireAdmin, updateWarehouseBase);

module.exports = router;
