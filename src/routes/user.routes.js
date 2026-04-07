// src/routes/user.routes.js
const express = require('express');
const router = express.Router();
const {
  getProfile,
  updateProfile,
  completeProfile,
  updateStepGoal,
  getNotifications,
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
} = require('../controllers/user.controller');
const {
  getAnalyticsDashboard,
  syncAnalyticsDashboard,
} = require('../controllers/health.controller');
const { protect } = require('../middleware/auth.middleware');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate.middleware');

const completeProfileRules = [
  body('phone').notEmpty().withMessage('Phone is required'),
  body('dob').isISO8601().withMessage('DOB must be a valid date'),
  body('gender').isIn(['M', 'F', 'O']).withMessage('Gender must be M, F, or O'),
  body('height').isFloat({ min: 50, max: 300 }).withMessage('Height must be 50–300 cm'),
  body('weight').isFloat({ min: 10, max: 500 }).withMessage('Weight must be 10–500 kg'),
  body('bloodType').notEmpty().withMessage('Blood type is required'),
];

// All user routes require auth
router.use(protect);

router.get('/profile', getProfile);
router.patch('/profile', updateProfile);
router.post('/complete-profile', completeProfileRules, validate, completeProfile);
router.patch('/step-goal', updateStepGoal);

// ─── Analytics — aliased here so frontend's `user/analytics?period=X` works ──
// The same controllers are also mounted at /health/analytics for backward compat
router.get('/analytics', getAnalyticsDashboard);
router.post('/analytics/sync', syncAnalyticsDashboard);

// ─── In-app notifications ────────────────────────────────────────────────────
router.get('/notifications', getNotifications);

// ─── Delivery addresses ───────────────────────────────────────────────────────
router.get('/addresses', getAddresses);
router.post('/addresses', addAddress);
router.patch('/addresses/:addressId', updateAddress);
router.delete('/addresses/:addressId', deleteAddress);

module.exports = router;

