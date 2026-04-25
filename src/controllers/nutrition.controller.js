// src/controllers/nutrition.controller.js
// ─── Full Diet & Nutrition API ────────────────────────────────────────────────
// Routes covered:
//   GET    /nutrition/summary?date=YYYY-MM-DD
//   POST   /nutrition/log
//   DELETE /nutrition/log/:id
//   GET    /nutrition/preferences
//   PUT    /nutrition/preferences
//   GET    /nutrition/foods?dietType=&category=&search=&page=&limit=
//   GET    /nutrition/foods/:id
//   POST   /nutrition/foods/:id/favourite   (toggle)
//   GET    /nutrition/favourites

const MealLog            = require('../models/MealLog.model');
const Food               = require('../models/Food.model');
const NutritionPref      = require('../models/NutritionPreference.model');
const AppConfig          = require('../models/AppConfig.model');
const FoodSynonym        = require('../models/FoodSynonym.model');
const { success, error } = require('../utils/response');

// ─── Helper: resolve a search term via synonym map ────────────────────────────
async function resolveSearchTerm(raw) {
  const term = raw.trim().toLowerCase();
  const synonym = await FoodSynonym.findOne({ aliases: term });
  return synonym ? synonym.canonical : raw.trim();
}

// ─── Helper: today ISO ────────────────────────────────────────────────────────

const todayISO = () => new Date().toISOString().split('T')[0];

// ─── Helper: get-or-create preferences ───────────────────────────────────────

async function getOrCreatePrefs(userId) {
  let prefs = await NutritionPref.findOne({ user: userId });
  if (!prefs) prefs = await NutritionPref.create({ user: userId });
  return prefs;
}

// ─── Helper: serialise a Food document adding isFavourite ────────────────────

function serialiseFood(food, favouriteIds) {
  const obj = food.toJSON ? food.toJSON() : food;
  return {
    ...obj,
    isFavourite: favouriteIds.some(id => id.toString() === obj._id.toString()),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DAILY SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /nutrition/summary?date=YYYY-MM-DD
 * Returns full daily nutrition breakdown including per-meal entries.
 */
const getDailySummary = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const date   = req.query.date || todayISO();

    const prefs = await getOrCreatePrefs(userId);

    // All entries for this user on this date
    const logs = await MealLog.find({ user: userId, date }).sort({ createdAt: 1 });

    // Aggregate totals
    let totalCaloriesIn = 0;
    let totalProtein    = 0;
    let totalCarbs      = 0;
    let totalFat        = 0;

    const meals = { breakfast: [], lunch: [], dinner: [], snacks: [] };

    for (const log of logs) {
      totalCaloriesIn += log.calories || 0;
      totalProtein    += log.protein  || 0;
      totalCarbs      += log.carbs    || 0;
      totalFat        += log.fat      || 0;
      meals[log.mealType].push(log.toJSON());
    }

    return success(res, 'Daily summary fetched', {
      date,
      totalCaloriesIn: Math.round(totalCaloriesIn),
      caloriesOut: 0,         // filled by the device (steps-based) — passed from app
      calorieGoal: prefs.calorieGoal,
      totalProtein:  Math.round(totalProtein),
      totalCarbs:    Math.round(totalCarbs),
      totalFat:      Math.round(totalFat),
      meals,
    });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  MEAL LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /nutrition/log
 * Body: { mealType, name, calories, protein?, carbs?, fat?, quantity?, unit?, foodRef? }
 */
const logMeal = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const {
      mealType,
      name,
      calories,
      protein,
      carbs,
      fat,
      quantity,
      unit,
      foodRef,
    } = req.body;

    // Validation
    if (!mealType || !['breakfast', 'lunch', 'dinner', 'snacks'].includes(mealType)) {
      return error(res, 'Invalid mealType. Must be one of: breakfast, lunch, dinner, snacks', 400);
    }
    if (!name || typeof name !== 'string') {
      return error(res, 'Food name is required', 400);
    }
    if (!calories || calories <= 0) {
      return error(res, 'Calories must be a positive number', 400);
    }

    const log = await MealLog.create({
      user: userId,
      date: todayISO(),
      mealType,
      name: name.trim(),
      calories: Number(calories),
      protein:  protein != null ? Number(protein) : null,
      carbs:    carbs   != null ? Number(carbs)   : null,
      fat:      fat     != null ? Number(fat)      : null,
      quantity: quantity != null ? Number(quantity) : null,
      unit:     unit     ?? null,
      foodRef:  foodRef  ?? null,
    });

    // Sync challenge progress after logging a meal (fire-and-forget)
    const { syncChallengeProgress } = require('./challenge.controller');
    syncChallengeProgress(userId).catch(() => {});

    return success(res, 'Meal logged successfully', log.toJSON(), 201);
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /nutrition/log/:id
 * Removes a meal log entry — only the owner can delete their own entry.
 */
const deleteMeal = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { id } = req.params;

    const log = await MealLog.findOne({ _id: id, user: userId });
    if (!log) return error(res, 'Meal log entry not found', 404);

    await log.deleteOne();

    return success(res, 'Meal log entry deleted', { deleted: true });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  NUTRITION PREFERENCES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /nutrition/preferences
 * Returns the current user's diet preferences and calorie goal.
 */
const getPreferences = async (req, res, next) => {
  try {
    const prefs = await getOrCreatePrefs(req.user._id);

    return success(res, 'Preferences fetched', {
      dietPreference: prefs.dietPreference,
      dietaryGoal:    prefs.dietaryGoal,
      calorieGoal:    prefs.calorieGoal,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /nutrition/preferences
 * Body: { dietPreference?, dietaryGoal?, calorieGoal? }
 */
const updatePreferences = async (req, res, next) => {
  try {
    const { dietPreference, dietaryGoal, calorieGoal } = req.body;

    const VALID_DIET  = ['veg', 'non-veg', 'vegan'];
    const VALID_GOALS = ['weight_loss', 'muscle_gain', 'maintenance', 'endurance'];

    if (dietPreference && !VALID_DIET.includes(dietPreference)) {
      return error(res, `Invalid dietPreference. Must be one of: ${VALID_DIET.join(', ')}`, 400);
    }
    if (dietaryGoal && !VALID_GOALS.includes(dietaryGoal)) {
      return error(res, `Invalid dietaryGoal. Must be one of: ${VALID_GOALS.join(', ')}`, 400);
    }
    if (calorieGoal && (calorieGoal < 500 || calorieGoal > 10000)) {
      return error(res, 'calorieGoal must be between 500 and 10,000 kcal', 400);
    }

    const update = {};
    if (dietPreference) update.dietPreference = dietPreference;
    if (dietaryGoal)    update.dietaryGoal    = dietaryGoal;
    if (calorieGoal)    update.calorieGoal    = Number(calorieGoal);

    const prefs = await NutritionPref.findOneAndUpdate(
      { user: req.user._id },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return success(res, 'Preferences updated', {
      dietPreference: prefs.dietPreference,
      dietaryGoal:    prefs.dietaryGoal,
      calorieGoal:    prefs.calorieGoal,
    });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  FOOD CATALOG
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /nutrition/foods
 * Query: ?dietType=veg&category=lunch&search=chicken&page=1&limit=20
 */
const getFoods = async (req, res, next) => {
  try {
    const userId = req.user._id;

    const { dietType, category, search, page = 1, limit = 20 } = req.query;

    const pageNum  = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const skip     = (pageNum - 1) * limitNum;

    // Build filter
    const filter = { isActive: true };
    if (dietType && dietType !== 'all')    filter.dietType = dietType;
    if (category && category !== 'all')    filter.category = category;
    if (search && search.trim().length >= 2) {
      const resolved = await resolveSearchTerm(search);
      filter.$text = { $search: resolved };
    }

    const [foods, total] = await Promise.all([
      Food.find(filter)
        .sort(search ? { score: { $meta: 'textScore' } } : { name: 1 })
        .skip(skip)
        .limit(limitNum),
      Food.countDocuments(filter),
    ]);

    // Load user favourites to inject isFavourite
    const prefs = await NutritionPref.findOne({ user: userId }).select('favourites');
    const favIds = prefs?.favourites ?? [];

    const serialised = foods.map(f => serialiseFood(f, favIds));

    return success(res, 'Foods fetched', {
      foods: serialised,
      total,
      page: pageNum,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /nutrition/foods/:id
 * Returns full detail for a single food item.
 */
const getFoodById = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const food   = await Food.findOne({ _id: req.params.id, isActive: true });
    if (!food) return error(res, 'Food not found', 404);

    const prefs = await NutritionPref.findOne({ user: userId }).select('favourites');
    const favIds = prefs?.favourites ?? [];

    return success(res, 'Food fetched', serialiseFood(food, favIds));
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  FAVOURITES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /nutrition/foods/:id/favourite
 * Toggles favourite status for the given food.
 * Returns: { isFavourite: boolean }
 */
const toggleFavourite = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const foodId = req.params.id;

    // Verify the food exists
    const food = await Food.findOne({ _id: foodId, isActive: true });
    if (!food) return error(res, 'Food not found', 404);

    const prefs = await getOrCreatePrefs(userId);

    const idx = prefs.favourites.findIndex(id => id.toString() === foodId);

    let isFavourite;
    if (idx >= 0) {
      // Already a favourite → remove
      prefs.favourites.splice(idx, 1);
      isFavourite = false;
    } else {
      // Not yet a favourite → add
      prefs.favourites.push(foodId);
      isFavourite = true;
    }

    await prefs.save();

    return success(res, isFavourite ? 'Added to favourites' : 'Removed from favourites', {
      isFavourite,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /nutrition/favourites
 * Returns all food items the user has favourited.
 */
const getFavourites = async (req, res, next) => {
  try {
    const userId = req.user._id;

    const prefs = await NutritionPref.findOne({ user: userId })
      .select('favourites')
      .populate({ path: 'favourites', match: { isActive: true } });

    if (!prefs) return success(res, 'Favourites fetched', { foods: [] });

    const foods = (prefs.favourites || []).map(f => serialiseFood(f, prefs.favourites));

    return success(res, 'Favourites fetched', { foods });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  NUTRITION OPTIONS  (diet preferences + dietary goals from AppConfig)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /nutrition/options
 * Returns the configurable diet preference chips and dietary goal chips.
 * Admins can update these via PATCH /config/app (nutrition.dietPreferences / nutrition.dietaryGoals).
 */
const getNutritionOptions = async (req, res, next) => {
  try {
    let cfg = await AppConfig.findOne({ key: 'global' });
    if (!cfg) cfg = await AppConfig.create({ key: 'global' });

    return success(res, 'Nutrition options fetched', {
      dietPreferences: cfg.nutrition.dietPreferences,
      dietaryGoals:    cfg.nutrition.dietaryGoals,
      catalogFilters:  cfg.nutrition.catalogFilters,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getNutritionOptions,
  getDailySummary,
  logMeal,
  deleteMeal,
  getPreferences,
  updatePreferences,
  getFoods,
  getFoodById,
  toggleFavourite,
  getFavourites,
};
