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
  addBonusSteps,
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
  getUserCoinLedger,
  getDashboardStats,
  setStepsTracking,
  getAppVersionStats,
  getUserDevice,
  getDeletionRequests,
  runDeletionJob,
  getUserSyncLogs,
  setSyncDebug,
  getUserStepProvenance,
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

// GET /admin/stats/app-versions?days=30 — install-base breakdown by app build.
router.get('/stats/app-versions', getAppVersionStats);

// ── Account deletion queue ───────────────────────────────────────────────────
// GET  /admin/deletions?status=pending|in_progress|blocked — open requests.
// POST /admin/deletions/run — run the purge job now instead of waiting for 4 AM.
router.get('/deletions', getDeletionRequests);
router.post('/deletions/run', runDeletionJob);

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
router.post('/users/:id/add-steps',
  body('steps').isInt({ min: 1 }).withMessage('steps must be a positive integer'),
  body('reason').isString().trim().notEmpty().withMessage('reason is required').isLength({ max: 200 }),
  body('date').optional().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('date must be YYYY-MM-DD format'),
  body('source').optional().isIn(['admin', 'system', 'reward', 'challenge']),
  validate, addBonusSteps);
router.post('/users/:id/reset-streak', resetUserStreak);
router.post('/users/:id/ban',
  body('reason').isString().trim().notEmpty().withMessage('A ban reason is required').isLength({ max: 300 }),
  validate, banUser);
router.post('/users/:id/unban', unbanUser);

// ── Per-user step-tracking kill switch ───────────────────────────────────────
// POST /admin/users/:id/steps-tracking  { enabled: boolean, reason?: string }
// Pauses/resumes step ingestion and step-derived coins for one user without
// touching the rest of their account. See setStepsTracking for why this is
// separate from ban.
router.post(
  '/users/:id/steps-tracking',
  param('id').isMongoId(),
  body('enabled').isBoolean().withMessage('enabled must be a boolean'),
  body('reason').optional().isString().isLength({ max: 300 }),
  validate,
  setStepsTracking,
);

// GET /admin/users/:id/device — build/device trail + per-day sync stamps.
router.get('/users/:id/device', param('id').isMongoId(), validate, getUserDevice);

// ── Raw sync trail ───────────────────────────────────────────────────────────
// GET  /admin/users/:id/sync-logs  — what the device sent vs what was kept.
// POST /admin/users/:id/sync-debug — { enabled, hours? } verbose tracing.
router.get('/users/:id/sync-logs', param('id').isMongoId(), validate, getUserSyncLogs);
router.post(
  '/users/:id/sync-debug',
  param('id').isMongoId(),
  body('enabled').isBoolean().withMessage('enabled must be a boolean'),
  body('hours').optional().isInt({ min: 1, max: 168 }),
  validate,
  setSyncDebug,
);
// ── Step attribution ─────────────────────────────────────────────────────────
// GET /admin/users/:id/step-provenance — where each day's steps came from, and
// what is behind every increase. `/sync-logs` shows that 17,000 steps arrived;
// this shows which app recorded them, over what clock hours, and how many days
// late they were delivered.
router.get(
  '/users/:id/step-provenance',
  param('id').isMongoId(),
  validate,
  getUserStepProvenance,
);

router.get('/users/:id/sessions', getUserSessions);
router.delete('/users/:id/sessions/:sessionId', revokeUserSession);
router.post('/users/:id/sessions/revoke-all', revokeAllUserSessions);
router.get('/users/:id/action-log', getUserActionLog);
router.delete('/users/:id', deleteUser);
router.get('/users/:id/health', getUserHealth);
router.get('/users/:id/coins', getUserCoinLedger);
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
  body('dietType').isArray({ min: 1 }).withMessage('at least one dietType is required'),
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
