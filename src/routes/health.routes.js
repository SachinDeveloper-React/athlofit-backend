const express = require('express');
const router = express.Router();
const {
  getWeeklySteps,
  syncHealthData,
  getHealthHistory,
  getTodayHealth,
  getAnalyticsDashboard,
  syncAnalyticsDashboard,
  saveBmi,
  getBmiHistory,
} = require('../controllers/health.controller');
const { protect } = require('../middleware/auth.middleware');

// All routes require auth
router.use(protect);

// GET /health/analytics?period=day
router.get('/analytics', getAnalyticsDashboard);

// POST /health/analytics/sync
router.post('/analytics/sync', syncAnalyticsDashboard);

// GET /health/weekly-steps?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/weekly-steps', getWeeklySteps);

// GET /health/today
router.get('/today', getTodayHealth);

// GET /health/history?from=&to=&limit=
router.get('/history', getHealthHistory);

// POST /health/sync  — push daily snapshot from device
router.post('/sync', syncHealthData);

// GET  /health/bmi        — fetch BMI history
// POST /health/bmi        — save a new BMI reading
router.get('/bmi',  getBmiHistory);
router.post('/bmi', saveBmi);

module.exports = router;
