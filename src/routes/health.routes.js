const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const {
  getWeeklySteps,
  syncHealthData,
  getHealthHistory,
  getTodayHealth,
  getAnalyticsDashboard,
  syncAnalyticsDashboard,
  getCalendarActivity,
  getPeriodStats,
  getDayDetail,
  saveBmi,
  getBmiHistory,
} = require('../controllers/health.controller');
const { protect } = require('../middleware/auth.middleware');

// FIX #4: Per-user rate limiter for POST /health/sync.
// 20 requests per minute per user — prevents API flooding while allowing
// normal usage (native service every 15 min + app sync on foreground + background fetch).
const syncRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Key by authenticated user ID (set by protect middleware)
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
  message: { success: false, message: 'Too many sync requests. Please wait a moment.' },
});

// All routes require auth
router.use(protect);

// GET /health/analytics?period=day
router.get('/analytics', getAnalyticsDashboard);

// POST /health/analytics/sync
router.post('/analytics/sync', syncAnalyticsDashboard);

// GET /health/calendar?year=YYYY&month=MM
router.get('/calendar', getCalendarActivity);

// GET /health/period-stats
router.get('/period-stats', getPeriodStats);

// GET /health/day-detail?date=YYYY-MM-DD
router.get('/day-detail', getDayDetail);

// GET /health/weekly-steps?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/weekly-steps', getWeeklySteps);

// GET /health/today
router.get('/today', getTodayHealth);

// GET /health/history?from=&to=&limit=
router.get('/history', getHealthHistory);

// POST /health/sync  — push daily snapshot from device
router.post('/sync', syncRateLimiter, syncHealthData);

// GET  /health/bmi        — fetch BMI history
// POST /health/bmi        — save a new BMI reading
router.get('/bmi',  getBmiHistory);
router.post('/bmi', saveBmi);

module.exports = router;
