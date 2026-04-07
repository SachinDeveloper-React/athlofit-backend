// src/routes/nutrition.routes.js
// ─── All /nutrition/* routes ──────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const {
  getDailySummary,
  logMeal,
  deleteMeal,
  getPreferences,
  updatePreferences,
  getFoods,
  getFoodById,
  toggleFavourite,
  getFavourites,
} = require('../controllers/nutrition.controller');
const { protect } = require('../middleware/auth.middleware');

// All routes require authentication
router.use(protect);

// ─── Daily Summary ────────────────────────────────────────────────────────────
// GET  /nutrition/summary?date=YYYY-MM-DD
router.get('/summary', getDailySummary);

// ─── Meal Logging ─────────────────────────────────────────────────────────────
// POST   /nutrition/log            → create new meal entry
// DELETE /nutrition/log/:id        → delete meal entry (owner only)
router.post('/log',        logMeal);
router.delete('/log/:id',  deleteMeal);

// ─── Preferences ──────────────────────────────────────────────────────────────
// GET /nutrition/preferences       → get diet pref + goal + calorie goal
// PUT /nutrition/preferences       → update diet pref + goal + calorie goal
router.get('/preferences', getPreferences);
router.put('/preferences', updatePreferences);

// ─── Favourites ───────────────────────────────────────────────────────────────
// GET /nutrition/favourites        → list all favourited foods
router.get('/favourites', getFavourites);

// ─── Food Catalog ─────────────────────────────────────────────────────────────
// GET  /nutrition/foods            → paginated list with filters
// GET  /nutrition/foods/:id        → single food detail
// POST /nutrition/foods/:id/favourite → toggle favourite
router.get('/foods',                getFoods);
router.get('/foods/:id',            getFoodById);
router.post('/foods/:id/favourite', toggleFavourite);

module.exports = router;
