// src/routes/phone.routes.js
const express = require('express');
const router = express.Router();
const { sendPhoneOtp, verifyPhoneOtp } = require('../controllers/phone.controller');
const { protect } = require('../middleware/auth.middleware');

// All phone routes require authentication
router.post('/send-otp', protect, sendPhoneOtp);
router.post('/verify-otp', protect, verifyPhoneOtp);

module.exports = router;
