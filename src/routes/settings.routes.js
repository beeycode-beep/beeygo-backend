const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { authenticateToken, requireAdmin } = require('../middlewares/auth');
const asyncHandler = require('../middlewares/asyncHandler');

router.get('/', asyncHandler(adminController.getSettings));
router.post('/', authenticateToken, requireAdmin, asyncHandler(adminController.updateSettings));

module.exports = router;
