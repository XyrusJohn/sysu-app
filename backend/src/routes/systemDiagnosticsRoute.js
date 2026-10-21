const express = require('express');
const rateLimit = require('express-rate-limit');
const {protectRoute} = require('../middleware/protectRoute');
const {authorize} = require('../middleware/authorize');
const controller = require('../controllers/systemDiagnosticsController');

const router = express.Router();
const reporters = ['driver', 'fleet_manager', 'admin', 'super_admin'];
const reportLimiter = rateLimit({windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false});

router.post('/report', reportLimiter, protectRoute, authorize(reporters), controller.reportClientError);
router.get('/logs', protectRoute, authorize(['admin', 'super_admin']), controller.listSystemErrors);
router.patch('/logs/:id/resolve', protectRoute, authorize(['admin', 'super_admin']), controller.resolveSystemError);

module.exports = router;
