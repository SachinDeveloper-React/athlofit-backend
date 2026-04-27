// src/validators/auth.validator.js
const { body } = require('express-validator');

const signupRules = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters'),
];

const loginRules = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required'),
];

const verifyOtpRules = [
  body('email').isEmail().withMessage('Valid email required'),
  body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
  body('flow').isIn(['signup', 'forgot_password']).withMessage('Invalid flow'),
];

const forgotPasswordRules = [
  body('email').isEmail().withMessage('Valid email required'),
];

const resetPasswordRules = [
  body('email').isEmail().withMessage('Valid email required'),
  body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
];

const resendOtpRules = [
  body('email').isEmail().withMessage('Valid email required'),
  body('flow').isIn(['signup', 'forgot_password']).withMessage('Invalid flow'),
];

module.exports = {
  signupRules,
  loginRules,
  verifyOtpRules,
  forgotPasswordRules,
  resetPasswordRules,
  resendOtpRules,
};
