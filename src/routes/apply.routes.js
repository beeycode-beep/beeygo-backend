const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { body, validationResult } = require('express-validator');
const asyncHandler = require('../middlewares/asyncHandler');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

const applyValidation = [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('country').trim().notEmpty().withMessage('Country is required'),
  body('telegram').trim().notEmpty().withMessage('Telegram handle required'),
  body('twitter').trim().notEmpty().withMessage('Twitter handle required'),
  body('channelHandle').trim().notEmpty().withMessage('Channel handle required'),
  body('userHandle').trim().notEmpty().withMessage('User handle required'),
  body('followerCount').notEmpty().withMessage('Follower count is required'),
  body('niche').trim().notEmpty().withMessage('Content niche required'),
  body('motivation').trim().isLength({ min: 100 }).withMessage('Motivation must be at least 100 characters'),
  body('promotionPlan').trim().isLength({ min: 50 }).withMessage('Promotion plan must be at least 50 characters'),
  validate,
];

router.get('/count', asyncHandler(adminController.getApplicationsCount));
router.post('/', applyValidation, asyncHandler(adminController.applyForAmbassador));

module.exports = router;
