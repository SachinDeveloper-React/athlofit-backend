// src/routes/referral.routes.js
const express = require('express');
const router = express.Router();
const { getReferralStats, applyReferralCode } = require('../controllers/referral.controller');
const { protect } = require('../middleware/auth.middleware');

router.use(protect);

// GET /referral/me — current user's referral code + stats
router.get('/me', getReferralStats);

// POST /referral/apply — apply a referral code
router.post('/apply', applyReferralCode);

module.exports = router;
