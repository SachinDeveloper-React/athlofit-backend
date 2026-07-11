// src/routes/shop.routes.js
const express = require('express');
const router = express.Router();
const {
  getCategories,
  getProducts,
  getFeaturedProducts,
  getProductById,
  getProductReviews,
  addReview,
  searchProducts,
  buyWithCoins,
  validateCoupon,
  getAvailableCoupons,
  getOrders,
  getOrderById,
  cancelOrder,
  confirmDelivery,
} = require('../controllers/shop.controller');
const { protect } = require('../middleware/auth.middleware');

// Public routes (no auth needed)
router.get('/categories', getCategories);
router.get('/products', getProducts);
router.get('/products/featured', getFeaturedProducts);
router.get('/products/:id', getProductById);
router.get('/products/:id/reviews', protect, getProductReviews);
router.get('/search', searchProducts);

// Protected routes
router.post('/products/:id/review', protect, addReview);
router.post('/cart/buy-with-coins', protect, buyWithCoins);
router.get('/coupons', protect, getAvailableCoupons);
router.post('/coupons/validate', protect, validateCoupon);
router.get('/orders', protect, getOrders);
router.get('/orders/:orderId', protect, getOrderById);
router.patch('/orders/:orderId/cancel', protect, cancelOrder);
router.patch('/orders/:orderId/confirm-delivery', protect, confirmDelivery);

module.exports = router;
