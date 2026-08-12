const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { authenticateToken, requireAdmin } = require('../middlewares/auth');
const asyncHandler = require('../middlewares/asyncHandler');
const { body, param, query, validationResult } = require('express-validator');

// Validation Middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }
  next();
};

// Validations
const taskValidation = [
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('description').trim().optional(),
  body('reward').isInt({ min: 1 }).withMessage('Reward must be a positive integer'),
  body('link').trim().optional(),
  body('platform').trim().optional(),
  body('active').isBoolean().optional(),
  body('verification_type').isIn(['auto', 'telegram_join', 'telegram_dm', 'code_submit']).optional(),
  body('chat_id').trim().optional(),
  validate
];

const adjustBalanceValidation = [
  body('balance').isInt({ min: 0 }).withMessage('Balance must be a non-negative integer'),
  body('reason').trim().optional(),
  validate
];

const updateApplicationValidation = [
  body('status').isIn(['pending', 'approved', 'rejected']).withMessage('Invalid status'),
  body('admin_notes').trim().optional(),
  validate
];

const updateWithdrawalValidation = [
  body('status').isIn(['processing', 'completed', 'failed', 'transfer_failed']).withMessage('Invalid status'),
  body('admin_note').trim().optional(),
  validate
];

// Tasks
router.get('/tasks', authenticateToken, requireAdmin, asyncHandler(adminController.getTasks));
router.post('/tasks', authenticateToken, requireAdmin, taskValidation, asyncHandler(adminController.createTask));
router.put('/tasks/:id', authenticateToken, requireAdmin, taskValidation, asyncHandler(adminController.updateTask));
router.delete('/tasks/:id', authenticateToken, requireAdmin, asyncHandler(adminController.deleteTask));

// Submissions
router.get('/submissions', authenticateToken, requireAdmin, asyncHandler(adminController.getAllSubmissions));
router.post('/tasks/:taskId/users/:userId/approve', authenticateToken, requireAdmin, asyncHandler(adminController.approveSubmission));

// Users
router.get('/users', authenticateToken, requireAdmin, asyncHandler(adminController.getUsers));
router.post('/users/:id/adjust', authenticateToken, requireAdmin, adjustBalanceValidation, asyncHandler(adminController.adjustUserBalance));

// Dashboard
router.get('/stats', authenticateToken, requireAdmin, asyncHandler(adminController.getStats));

// Ambassador Applications
router.get('/applications', authenticateToken, requireAdmin, asyncHandler(adminController.getApplications));
router.get('/applications/:id', authenticateToken, requireAdmin, asyncHandler(adminController.getApplication));
router.put('/applications/:id', authenticateToken, requireAdmin, updateApplicationValidation, asyncHandler(adminController.updateApplication));
router.delete('/applications/:id', authenticateToken, requireAdmin, asyncHandler(adminController.deleteApplication));

// Withdrawals
router.get('/withdrawals', authenticateToken, requireAdmin, asyncHandler(adminController.getWithdrawals));
router.put('/withdrawals/:id', authenticateToken, requireAdmin, updateWithdrawalValidation, asyncHandler(adminController.updateWithdrawal));
router.post('/withdrawals/:id/retry', authenticateToken, requireAdmin, asyncHandler(adminController.retryWithdrawal));

module.exports = router;
