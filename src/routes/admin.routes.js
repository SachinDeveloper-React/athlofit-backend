// src/routes/admin.routes.js
const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const { protect, adminOnly } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { imageUpload } = require('../middleware/upload.middleware');

const {
  getUsers,
  getUserById,
  updateUserRole,
  updateUserAccount,
  adjustUserCoins,
  resetUserStreak,
  banUser,
  unbanUser,
  getUserSessions,
  revokeUserSession,
  revokeAllUserSessions,
  getUserActionLog,
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

const {
  getFoods,
  createFood,
  updateFood,
  deleteFood,
  toggleFood,
  bulkUpload,
} = require('../controllers/adminFood.controller');

const { getUserAnalytics } = require('../controllers/adminAnalytics.controller');
const { analyzeUser, recommendForUser } = require('../controllers/adminAI.controller');

// All routes here require an authenticated admin.
router.use(protect, adminOnly);

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard/stats', getDashboardStats);

// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/users', getUsers);
router.get('/users/:id', getUserById);
router.patch('/users/:id',
  body('name').optional().isString().trim().notEmpty(),
  body('dailyStepGoal').optional().isInt({ min: 0, max: 100000 }),
  body('emailVerified').optional().isBoolean(),
  body('phoneVerified').optional().isBoolean(),
  validate, updateUserAccount);
router.patch('/users/:id/role',
  body('role').isIn(['user', 'admin']).withMessage('role must be user or admin'),
  validate, updateUserRole);
router.post('/users/:id/coins',
  body('amount').isFloat().withMessage('amount must be a number')
    .custom((v) => Number(v) !== 0).withMessage('amount cannot be zero'),
  body('reason').optional().isString().isLength({ max: 300 }),
  validate, adjustUserCoins);
router.post('/users/:id/reset-streak', resetUserStreak);
router.post('/users/:id/ban',
  body('reason').isString().trim().notEmpty().withMessage('A ban reason is required').isLength({ max: 300 }),
  validate, banUser);
router.post('/users/:id/unban', unbanUser);
router.get('/users/:id/sessions', getUserSessions);
router.delete('/users/:id/sessions/:sessionId', revokeUserSession);
router.post('/users/:id/sessions/revoke-all', revokeAllUserSessions);
router.get('/users/:id/action-log', getUserActionLog);
router.delete('/users/:id', deleteUser);
router.get('/users/:id/health', getUserHealth);
router.get('/users/:id/gamification', getUserGamification);
router.get('/users/:id/achievements', getUserAchievements);
router.get('/users/:id/orders', getUserOrders);
router.get('/users/:id/analytics', getUserAnalytics);
router.post('/users/:id/ai-analysis', analyzeUser);
router.post('/users/:id/ai-recommendations', recommendForUser);

// ── Shop: Products ──────────────────────────────────────────────────────────
router.post('/shop/products',
  imageUpload.array('images', 8),
  body('name').isString().trim().notEmpty().withMessage('name is required'),
  body('description').isString().trim().notEmpty().withMessage('description is required'),
  body('price').isFloat({ min: 0 }).withMessage('price must be a non-negative number'),
  body('category').isString().trim().notEmpty().withMessage('category is required'),
  validate, createProduct);
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

// ── Food Catalog (admin) ──────────────────────────────────────────────────────
const multer = require('multer');
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'text/csv', 'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    if (allowed.includes(file.mimetype) || /\.(csv|xlsx|xls)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV, XLSX, or XLS files are allowed'));
    }
  },
});
router.get('/foods', getFoods);
router.post('/foods',
  body('name').isString().trim().notEmpty().withMessage('name is required'),
  body('calories').isFloat({ min: 0 }).withMessage('calories must be a non-negative number'),
  body('protein').isFloat({ min: 0 }),
  body('carbs').isFloat({ min: 0 }),
  body('fat').isFloat({ min: 0 }),
  body('dietType').isIn(['veg', 'vegetarian', 'non-veg', 'vegan']).withMessage('invalid dietType'),
  validate, createFood);
router.put('/foods/:id', updateFood);
router.delete('/foods/:id', deleteFood);
router.patch('/foods/:id/toggle', toggleFood);
router.post('/foods/bulk-upload', csvUpload.single('file'), bulkUpload);

// ── Migrations ──────────────────────────────────────────────────────────────
const { consolidatePassiveStepCoins } = require('../migrations/consolidatePassiveStepCoins');
router.post('/consolidate-passive-coins', async (req, res, next) => {
  try {
    const userId = req.body.userId || null; // optional: run for a specific user
    const result = await consolidatePassiveStepCoins(userId);
    return res.json({ success: true, message: 'Duplicate PASSIVE_STEPS entries consolidated', data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
