// src/routes/auth.routes.js
const express = require('express');
const router = express.Router();
const {
  signup,
  verifySignupOtp,
  login,
  refreshToken,
  logout,
  forgotPassword,
  resendOtp,
  resetPassword,
} = require('../controllers/auth.controller');
const {
  signupRules,
  loginRules,
  verifyOtpRules,
  forgotPasswordRules,
  resetPasswordRules,
  resendOtpRules,
} = require('../validators/auth.validator');
const { validate } = require('../middleware/validate.middleware');
const { protect } = require('../middleware/auth.middleware');

// Public routes
router.post('/user/signup', signupRules, validate, signup);
router.post('/user/signup-verify', verifyOtpRules, validate, verifySignupOtp);
router.post('/user/login', loginRules, validate, login);
router.post('/user/refresh-token', refreshToken);
router.post('/forgot-password', forgotPasswordRules, validate, forgotPassword);
router.post('/resend-otp', resendOtpRules, validate, resendOtp);
router.post('/reset-password', resetPasswordRules, validate, resetPassword);

// Protected
router.post('/logout', protect, logout);

module.exports = router;
