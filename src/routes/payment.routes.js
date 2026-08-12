const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { authenticateToken, requireUser } = require('../middlewares/auth');
const asyncHandler = require('../middlewares/asyncHandler');
const { withdrawalLimiter } = require('../middlewares/rateLimit');
const { body, validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

const withdrawalValidation = [
  body('bygoAmount').isInt({ min: 1 }).withMessage('bygoAmount must be a positive integer'),
  validate,
];

// IPN route — raw body for HMAC verification, no auth
router.post('/ipn', express.raw({ type: 'application/json' }), paymentController.ipnCallback);

router.post('/create-withdrawal-fee', authenticateToken, requireUser, withdrawalLimiter, withdrawalValidation, asyncHandler(paymentController.createWithdrawalFee));
router.get('/:paymentId/status', authenticateToken, requireUser, asyncHandler(paymentController.getPaymentStatus));
router.post('/:paymentId/cancel', authenticateToken, requireUser, asyncHandler(paymentController.cancelPayment));

module.exports = router;
