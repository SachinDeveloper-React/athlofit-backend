// src/routes/payment.routes.js
const express = require('express');
const router = express.Router();
const {
  createPaymentOrder,
  verifyPayment,
} = require('../controllers/payment.controller');
const { protect } = require('../middleware/auth.middleware');

// Protected — requires a logged-in user
router.post('/create-order', protect, createPaymentOrder);
router.post('/verify',       protect, verifyPayment);

module.exports = router;
