// src/routes/payment.routes.js
const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const {
  createPaymentOrder,
  verifyPayment,
} = require('../controllers/payment.controller');
const { protect } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');

// Protected — requires a logged-in user
router.post('/create-order',
  protect,
  body('items').isArray({ min: 1 }).withMessage('items must be a non-empty array'),
  body('items.*.productId').isString().trim().notEmpty().withMessage('each item needs a productId'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('each item needs quantity >= 1'),
  body('shippingAddress.street').isString().trim().notEmpty().withMessage('street is required'),
  body('shippingAddress.city').isString().trim().notEmpty().withMessage('city is required'),
  body('shippingAddress.state').isString().trim().notEmpty().withMessage('state is required'),
  body('shippingAddress.zipCode').isString().trim().notEmpty().withMessage('zipCode is required'),
  validate,
  createPaymentOrder,
);

router.post('/verify',
  protect,
  body('razorpayOrderId').isString().trim().notEmpty(),
  body('razorpayPaymentId').isString().trim().notEmpty(),
  body('razorpaySignature').isString().trim().notEmpty(),
  validate,
  verifyPayment,
);

module.exports = router;
