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
  getOrders,
  cancelOrder,
} = require('../controllers/shop.controller');
const { protect } = require('../middleware/auth.middleware');

// Public routes (no auth needed)
router.get('/categories', getCategories);
router.get('/products', getProducts);
router.get('/products/featured', getFeaturedProducts);
router.get('/products/:id', getProductById);
router.get('/products/:id/reviews', getProductReviews);
router.get('/search', searchProducts);

// Protected routes
router.post('/products/:id/review', protect, addReview);
router.post('/cart/buy-with-coins', protect, buyWithCoins);
router.get('/orders', protect, getOrders);
router.patch('/orders/:orderId/cancel', protect, cancelOrder);

module.exports = router;
