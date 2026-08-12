const express = require('express');
const router = express.Router();
const taskController = require('../controllers/task.controller');
const { authenticateToken, requireUser } = require('../middlewares/auth');
const asyncHandler = require('../middlewares/asyncHandler');
const { body, validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

const dmVerifyValidation = [
  body('code').trim().notEmpty().withMessage('Verification code is required'),
  validate,
];

const proofValidation = [
  body('proof').optional().trim().isLength({ min: 3, max: 300 }).withMessage('Proof must be between 3 and 300 characters'),
  validate,
];

router.get('/', authenticateToken, requireUser, asyncHandler(taskController.getTasks));
router.post('/:id/verify', authenticateToken, requireUser, proofValidation, asyncHandler(taskController.verifyTask));
router.post('/:id/dm-verify', authenticateToken, requireUser, dmVerifyValidation, asyncHandler(taskController.verifyDMChallenge));

module.exports = router;
