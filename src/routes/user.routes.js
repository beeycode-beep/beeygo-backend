const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { authenticateToken, requireUser } = require('../middlewares/auth');
const asyncHandler = require('../middlewares/asyncHandler');
const { body, validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

const walletValidation = [
  body('walletAddress').trim().notEmpty().withMessage('walletAddress is required')
    .matches(/^0x[a-fA-F0-9]{40}$/).withMessage('Invalid BEP-20 wallet address format.'),
  validate,
];

// All user routes require 'user' role JWT
router.get('/me', authenticateToken, requireUser, asyncHandler(userController.getMe));
router.post('/me/daily-claim', authenticateToken, requireUser, asyncHandler(userController.dailyClaim));
router.post('/me/spin', authenticateToken, requireUser, asyncHandler(userController.spin));
router.get('/leaderboard', authenticateToken, asyncHandler(userController.leaderboard)); // open to users & admin
router.post('/me/claim', authenticateToken, requireUser, asyncHandler(userController.claim));
router.post('/me/wallet', authenticateToken, requireUser, walletValidation, asyncHandler(userController.saveWallet));
router.delete('/me/wallet', authenticateToken, requireUser, asyncHandler(userController.removeWallet));

module.exports = router;
