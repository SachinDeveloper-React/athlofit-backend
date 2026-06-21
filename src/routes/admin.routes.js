// src/routes/admin.routes.js
const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middleware/auth.middleware');
const { imageUpload } = require('../middleware/upload.middleware');

const {
  getUsers,
  getUserById,
  updateUserRole,
  deleteUser,
  getUserHealth,
  getUserGamification,
  getUserAchievements,
  getUserOrders,
  getDashboardStats,
} = require('../controllers/admin.controller');

const {
  createProduct,
  updateProduct,
  deleteProduct,
  createCategory,
  updateCategory,
  deleteCategory,
  getCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  getOrders,
  updateOrderStatus,
} = require('../controllers/adminShop.controller');

// All routes here require an authenticated admin.
router.use(protect, adminOnly);

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard/stats', getDashboardStats);

// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/users', getUsers);
router.get('/users/:id', getUserById);
router.patch('/users/:id/role', updateUserRole);
router.delete('/users/:id', deleteUser);
router.get('/users/:id/health', getUserHealth);
router.get('/users/:id/gamification', getUserGamification);
router.get('/users/:id/achievements', getUserAchievements);
router.get('/users/:id/orders', getUserOrders);

// ── Shop: Products ──────────────────────────────────────────────────────────
router.post('/shop/products', imageUpload.array('images', 8), createProduct);
router.put('/shop/products/:id', imageUpload.array('images', 8), updateProduct);
router.delete('/shop/products/:id', deleteProduct);

// ── Shop: Categories ──────────────────────────────────────────────────────────
router.post('/shop/categories', createCategory);
router.put('/shop/categories/:id', updateCategory);
router.delete('/shop/categories/:id', deleteCategory);

// ── Shop: Coupons ───────────────────────────────────────────────────────────
router.get('/shop/coupons', getCoupons);
router.post('/shop/coupons', createCoupon);
router.put('/shop/coupons/:id', updateCoupon);
router.delete('/shop/coupons/:id', deleteCoupon);

// ── Shop: Orders ────────────────────────────────────────────────────────────
router.get('/shop/orders', getOrders);
router.patch('/shop/orders/:id/status', updateOrderStatus);

module.exports = router;
