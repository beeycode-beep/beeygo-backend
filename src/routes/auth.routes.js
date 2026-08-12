const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authLimiter } = require('../middlewares/rateLimit');
const { authenticateToken } = require('../middlewares/auth');
const asyncHandler = require('../middlewares/asyncHandler');
const { body, validationResult } = require('express-validator');

// Validation Middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }
  next();
};

const loginValidation = [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').trim().notEmpty().withMessage('Password is required'),
  validate
];

const telegramAuthValidation = [
  body('initData').trim().notEmpty().withMessage('initData is required'),
  body('referralId').optional(),
  validate
];

router.post('/login', authLimiter, loginValidation, asyncHandler(authController.adminLogin));
router.get('/verify', authenticateToken, asyncHandler(authController.verifyUser));
router.post('/telegram', authLimiter, telegramAuthValidation, asyncHandler(authController.telegramAuth));

module.exports = router;
