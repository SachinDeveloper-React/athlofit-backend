// src/controllers/challenge.controller.js
const Challenge     = require('../models/Challenge.model');
const UserChallenge = require('../models/UserChallenge.model');
const Gamification  = require('../models/Gamification.model');
const HealthActivity = require('../models/HealthActivity.model');
const MealLog       = require('../models/MealLog.model');
const { success, error } = require('../utils/response');
const { todayISO } = require('../utils/date');
const { sendPushToUser } = require('../utils/pushNotification');
const { createNotification } = require('../utils/createNotification');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDailyPeriodKey() {
  return todayISO(); // "YYYY-MM-DD"
}

function getWeeklyPeriodKey() {
  const now = new Date();
  const year = now.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  const week = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function getPeriodKey(type) {
  return type === 'daily' ? getDailyPeriodKey() : getWeeklyPeriodKey();
}

async function ensureGamDoc(userId) {
  let gam = await Gamification.findOne({ user: userId });
  if (!gam) gam = await Gamification.create({ user: userId });
  return gam;
}

// ─── GET /challenges ──────────────────────────────────────────────────────────
// Returns all active challenges with the user's current progress for this period.
const getChallenges = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const challenges = await Challenge.find({ isActive: true }).sort({ type: 1, order: 1 });

    // Fetch user progress for all challenges in one query
    const periodKeys = [...new Set(challenges.map(c => getPeriodKey(c.type)))];
    const userProgress = await UserChallenge.find({
      user: userId,
      challenge: { $in: challenges.map(c => c._id) },
      periodKey: { $in: periodKeys },
    });

    const progressMap = {};
    userProgress.forEach(up => {
      progressMap[`${up.challenge}_${up.periodKey}`] = up;
    });

    const result = challenges.map(c => {
      const key = getPeriodKey(c.type);
      const progress = progressMap[`${c._id}_${key}`];
      const isRewarded  = progress?.isRewarded  ?? false;
      const isCompleted = isRewarded ? true : (progress?.isCompleted ?? false);
      // If already rewarded, show full progress — never go back to 0
      const currentValue = isRewarded
        ? c.targetValue
        : (progress?.currentValue ?? 0);
      return {
        ...c.toJSON(),
        currentValue,
        isCompleted,
        isRewarded,
        periodKey: key,
      };
    });

    return success(res, 'Challenges fetched', result);
  } catch (err) {
    next(err);
  }
};

// ─── GET /challenges/:id ──────────────────────────────────────────────────────
const getChallengeById = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const challenge = await Challenge.findById(req.params.id);
    if (!challenge || !challenge.isActive) return error(res, 'Challenge not found', 404);

    const periodKey = getPeriodKey(challenge.type);
    const progress = await UserChallenge.findOne({ user: userId, challenge: challenge._id, periodKey });
    const isRewarded  = progress?.isRewarded  ?? false;
    const isCompleted = isRewarded ? true : (progress?.isCompleted ?? false);
    const currentValue = isRewarded ? challenge.targetValue : (progress?.currentValue ?? 0);

    return success(res, 'Challenge fetched', {
      ...challenge.toJSON(),
      currentValue,
      isCompleted,
      isRewarded,
      periodKey,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /challenges/sync ────────────────────────────────────────────────────
// Called automatically from health/sync and nutrition/log.
// Updates progress for all active challenges and auto-awards coins when completed.
const syncChallengeProgress = async (userId) => {
  try {
    const today = todayISO();
    const challenges = await Challenge.find({ isActive: true });
    if (!challenges.length) return;

    // Fetch today's health activity
    const activity = await HealthActivity.findOne({ user: userId, date: today });

    // Fetch today's meal logs for nutrition challenges
    const mealLogs = await MealLog.find({ user: userId, date: today });
    const totalCaloriesLogged = mealLogs.reduce((s, m) => s + (m.calories || 0), 0);
    const totalProteinLogged  = mealLogs.reduce((s, m) => s + (m.protein  || 0), 0);
    const mealsLoggedCount    = mealLogs.length;

    // Weekly data for weekly challenges
    const weekKey = getWeeklyPeriodKey();
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
    const weekStartISO = weekStart.toISOString().split('T')[0];
    const weekActivities = await HealthActivity.find({
      user: userId,
      date: { $gte: weekStartISO, $lte: today },
    });

    const weeklySteps     = weekActivities.reduce((s, a) => s + (a.steps || 0), 0);
    const weeklyCalories  = weekActivities.reduce((s, a) => s + (a.calories || 0), 0);
    const weeklyHydration = weekActivities.reduce((s, a) => s + (a.hydration || 0), 0);
    const weeklyMinutes   = weekActivities.reduce((s, a) => s + (a.activeMinutes || 0), 0);
    const weeklyDistance  = weekActivities.reduce((s, a) => s + (a.distance || 0), 0);

    // Weekly nutrition data
    const weeklyMealLogs = await MealLog.find({
      user: userId,
      date: { $gte: weekStartISO, $lte: today },
    });
    const weeklyCaloriesLogged = weeklyMealLogs.reduce((s, m) => s + (m.calories || 0), 0);
    const weeklyProteinLogged  = weeklyMealLogs.reduce((s, m) => s + (m.protein  || 0), 0);
    // Count distinct days with at least one meal logged
    const weeklyNutritionDays  = new Set(weeklyMealLogs.map(m => m.date)).size;

    const gam = await ensureGamDoc(userId);
    let coinsToAdd = 0;
    const newlyCompleted = []; // challenges that just got completed this sync

    for (const challenge of challenges) {
      const periodKey = getPeriodKey(challenge.type);

      // Compute current value based on criteria
      let currentValue = 0;
      if (challenge.type === 'daily') {
        switch (challenge.criteriaType) {
          case 'STEPS':               currentValue = activity?.steps         ?? 0; break;
          case 'CALORIES':            currentValue = activity?.calories      ?? 0; break;
          case 'HYDRATION':           currentValue = activity?.hydration     ?? 0; break;
          case 'ACTIVE_MINUTES':      currentValue = activity?.activeMinutes ?? 0; break;
          case 'DISTANCE':            currentValue = activity?.distance      ?? 0; break;
          case 'MEALS_LOGGED':        currentValue = mealsLoggedCount;              break;
          case 'NUTRITION_CALORIES':  currentValue = totalCaloriesLogged;           break;
          case 'NUTRITION_PROTEIN':   currentValue = totalProteinLogged;            break;
          case 'NUTRITION_DAYS':      currentValue = mealsLoggedCount > 0 ? 1 : 0; break;
          case 'SPECIFIC_FOOD': {
            const foodName = (challenge.targetFood || '').toLowerCase();
            currentValue = mealLogs.filter(m =>
              m.name?.toLowerCase().includes(foodName)
            ).length;
            break;
          }
        }
      } else {
        switch (challenge.criteriaType) {
          case 'STEPS':               currentValue = weeklySteps;           break;
          case 'CALORIES':            currentValue = weeklyCalories;        break;
          case 'HYDRATION':           currentValue = weeklyHydration;       break;
          case 'ACTIVE_MINUTES':      currentValue = weeklyMinutes;         break;
          case 'DISTANCE':            currentValue = weeklyDistance;        break;
          case 'MEALS_LOGGED':        currentValue = mealsLoggedCount;      break;
          case 'NUTRITION_CALORIES':  currentValue = weeklyCaloriesLogged;  break;
          case 'NUTRITION_PROTEIN':   currentValue = weeklyProteinLogged;   break;
          case 'NUTRITION_DAYS':      currentValue = weeklyNutritionDays;   break;
          case 'SPECIFIC_FOOD': {
            const foodName = (challenge.targetFood || '').toLowerCase();
            const daysWithFood = new Set(
              weeklyMealLogs
                .filter(m => m.name?.toLowerCase().includes(foodName))
                .map(m => m.date)
            ).size;
            currentValue = daysWithFood;
            break;
          }
        }
      }

      const isCompleted = currentValue >= challenge.targetValue;

      // Upsert user challenge progress —
      // If already rewarded, never overwrite currentValue or isCompleted downward.
      // The challenge is locked once coins are earned.
      const existing = await UserChallenge.findOne(
        { user: userId, challenge: challenge._id, periodKey },
      );

      if (existing?.isRewarded) {
        // Already rewarded — skip any update, progress is locked
        continue;
      }

      await UserChallenge.findOneAndUpdate(
        { user: userId, challenge: challenge._id, periodKey },
        {
          $set: {
            currentValue,
            isCompleted,
            completedAt: isCompleted ? new Date() : null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      // Auto-award coins if just completed and not yet rewarded
      if (isCompleted && !existing?.isRewarded) {
        const doc = await UserChallenge.findOneAndUpdate(
          { user: userId, challenge: challenge._id, periodKey },
          { $set: { isRewarded: true, rewardedAt: new Date() } },
          { new: true },
        );
        if (!doc) continue;

        coinsToAdd += challenge.coinReward;
        newlyCompleted.push({
          title:      challenge.title,
          emoji:      challenge.emoji,
          coinReward: challenge.coinReward,
        });

        // ── Persist + push notification ───────────────────────────────────
        createNotification(userId, {
          type:    'CHALLENGE',
          title:   `${challenge.emoji} Challenge Complete!`,
          message: `You finished "${challenge.title}" and earned ${challenge.coinReward} coins!`,
          data:    { screen: 'ChallengeDetail', params: JSON.stringify({ challengeId: challenge._id.toString() }) },
        });

        gam.claimHistory.push({
          rewardId: `challenge_${challenge._id}_${periodKey}`,
          amount: challenge.coinReward,
          source: `Challenge: ${challenge.title}`,
          createdAt: new Date(),
        });
        if (gam.claimHistory.length > 50) gam.claimHistory.shift();
      }
    }

    if (coinsToAdd > 0) {
      gam.coinsBalance = Math.round(gam.coinsBalance + coinsToAdd);
      await gam.save();
    }

    return { coinsAdded: coinsToAdd, newlyCompleted };
  } catch (err) {
    console.error('[syncChallengeProgress] error:', err.message);
    return { coinsAdded: 0, newlyCompleted: [] };
  }
};

// ─── GET /challenges/config ───────────────────────────────────────────────────
// Returns all filter options and section labels — fully dynamic from the server.
// Add new categories/types here without touching the frontend.
const getChallengeConfig = async (req, res, next) => {
  try {
    // Derive available categories from active challenges in DB
    const activeChallenges = await Challenge.find({ isActive: true }).select('type category');

    const typeSet = new Set(activeChallenges.map(c => c.type));
    const catSet  = new Set(activeChallenges.map(c => c.category));

    const TYPE_META = {
      daily:  { label: 'Daily',  emoji: '🌅' },
      weekly: { label: 'Weekly', emoji: '📅' },
    };

    const CAT_META = {
      fitness:   { label: 'Fitness',   emoji: '🏃' },
      nutrition: { label: 'Nutrition', emoji: '🥗' },
      hydration: { label: 'Hydration', emoji: '💧' },
      wellness:  { label: 'Wellness',  emoji: '🧘' },
    };

    const SECTION_META = {
      'daily-fitness':    { label: '🏃 Daily Fitness'    },
      'daily-nutrition':  { label: '🥗 Daily Nutrition'  },
      'daily-hydration':  { label: '💧 Daily Hydration'  },
      'daily-wellness':   { label: '🧘 Daily Wellness'   },
      'weekly-fitness':   { label: '🏅 Weekly Fitness'   },
      'weekly-nutrition': { label: '🥗 Weekly Nutrition' },
      'weekly-hydration': { label: '🌊 Weekly Hydration' },
      'weekly-wellness':  { label: '🧘 Weekly Wellness'  },
    };

    // Build type filters — only include types that have active challenges
    const typeFilters = [
      { key: 'all', label: 'All', emoji: '🏆' },
      ...[...typeSet].sort().map(t => ({
        key: t,
        label: TYPE_META[t]?.label ?? t,
        emoji: TYPE_META[t]?.emoji ?? '📌',
      })),
    ];

    // Build category filters — only include categories that have active challenges
    const catFilters = [
      { key: 'all', label: 'All', emoji: '✨' },
      ...[...catSet].sort().map(c => ({
        key: c,
        label: CAT_META[c]?.label ?? c,
        emoji: CAT_META[c]?.emoji ?? '📌',
      })),
    ];

    // Build section labels for all type×category combos that exist
    const sectionLabels = {};
    for (const type of typeSet) {
      for (const cat of catSet) {
        const key = `${type}-${cat}`;
        sectionLabels[key] = SECTION_META[key]?.label ?? `${type} ${cat}`;
      }
    }

    return success(res, 'Challenge config fetched', {
      typeFilters,
      catFilters,
      sectionLabels,
    });
  } catch (err) {
    next(err);
  }
};
const adminUpsertChallenge = async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = req.body;

    let challenge;
    if (id) {
      challenge = await Challenge.findByIdAndUpdate(id, { $set: body }, { new: true, runValidators: true });
      if (!challenge) return error(res, 'Challenge not found', 404);
    } else {
      challenge = await Challenge.create(body);
    }

    return success(res, id ? 'Challenge updated' : 'Challenge created', challenge, id ? 200 : 201);
  } catch (err) {
    next(err);
  }
};

// ─── POST /challenges/seed  (admin only) ─────────────────────────────────────
// Inserts / updates all default challenges via API — no SSH needed.
const seedChallenges = async (req, res, next) => {
  try {
    const SEED = [
      // Daily — Fitness
      { title: 'Step Starter',       description: 'Walk 5,000 steps today.',                    emoji: '👟', color: '#0099FF', category: 'fitness',   type: 'daily',  criteriaType: 'STEPS',              targetValue: 5000,  coinReward: 30,  order: 1  },
      { title: 'Step Master',        description: 'Walk 10,000 steps today.',                   emoji: '🏃', color: '#0077CC', category: 'fitness',   type: 'daily',  criteriaType: 'STEPS',              targetValue: 10000, coinReward: 60,  order: 2  },
      { title: 'Calorie Torch',      description: 'Burn 300 active calories today.',            emoji: '🔥', color: '#F97316', category: 'fitness',   type: 'daily',  criteriaType: 'CALORIES',           targetValue: 300,   coinReward: 40,  order: 3  },
      { title: '4000 Kcal Burner',   description: 'Burn 4,000 active calories today.',          emoji: '💥', color: '#DC2626', category: 'fitness',   type: 'daily',  criteriaType: 'CALORIES',           targetValue: 4000,  coinReward: 150, order: 4  },
      { title: 'Active 30',          description: 'Stay active for 30 minutes today.',          emoji: '⏱️', color: '#F59E0B', category: 'fitness',   type: 'daily',  criteriaType: 'ACTIVE_MINUTES',     targetValue: 30,    coinReward: 35,  order: 5  },
      { title: 'Active Hour',        description: 'Stay active for 60 minutes today.',          emoji: '💪', color: '#D97706', category: 'fitness',   type: 'daily',  criteriaType: 'ACTIVE_MINUTES',     targetValue: 60,    coinReward: 60,  order: 6  },
      { title: 'Daily Distance',     description: 'Cover 3 km today.',                          emoji: '🗺️', color: '#10B981', category: 'fitness',   type: 'daily',  criteriaType: 'DISTANCE',           targetValue: 3,     coinReward: 35,  order: 7  },
      // Daily — Hydration
      { title: 'Hydration Starter',  description: 'Drink 1,000 ml of water today.',             emoji: '💧', color: '#06B6D4', category: 'hydration', type: 'daily',  criteriaType: 'HYDRATION',          targetValue: 1000,  coinReward: 20,  order: 8  },
      { title: 'Hydration Hero',     description: 'Drink 2,000 ml of water today.',             emoji: '🌊', color: '#0891B2', category: 'hydration', type: 'daily',  criteriaType: 'HYDRATION',          targetValue: 2000,  coinReward: 35,  order: 9  },
      { title: 'Water Champion',     description: 'Drink 3,000 ml of water today.',             emoji: '🏆', color: '#0E7490', category: 'hydration', type: 'daily',  criteriaType: 'HYDRATION',          targetValue: 3000,  coinReward: 50,  order: 10 },
      // Daily — Nutrition
      { title: 'Meal Logger',        description: 'Log at least 3 meals today.',                emoji: '🍽️', color: '#10B981', category: 'nutrition', type: 'daily',  criteriaType: 'MEALS_LOGGED',       targetValue: 3,     coinReward: 25,  order: 11 },
      { title: 'Full Day Logger',    description: 'Log all 4 meals today.',                     emoji: '📋', color: '#059669', category: 'nutrition', type: 'daily',  criteriaType: 'MEALS_LOGGED',       targetValue: 4,     coinReward: 40,  order: 12 },
      { title: 'Calorie Goal',       description: 'Log 1,500 kcal in meals today.',             emoji: '🥗', color: '#22C55E', category: 'nutrition', type: 'daily',  criteriaType: 'NUTRITION_CALORIES', targetValue: 1500,  coinReward: 30,  order: 13 },
      { title: 'Protein Power',      description: 'Log 100g of protein in meals today.',        emoji: '🥩', color: '#EF4444', category: 'nutrition', type: 'daily',  criteriaType: 'NUTRITION_PROTEIN',  targetValue: 100,   coinReward: 45,  order: 14 },
      { title: 'Egg Champion',       description: 'Log eggs in your meals today.',              emoji: '🥚', color: '#F59E0B', category: 'nutrition', type: 'daily',  criteriaType: 'SPECIFIC_FOOD',      targetFood: 'egg',  targetValue: 1,  coinReward: 20,  order: 15 },
      // Weekly — Fitness
      { title: 'Weekly Walker',      description: 'Walk 50,000 steps this week.',               emoji: '🚶', color: '#6366F1', category: 'fitness',   type: 'weekly', criteriaType: 'STEPS',              targetValue: 50000, coinReward: 200, order: 16 },
      { title: 'Step Legend',        description: 'Walk 70,000 steps this week.',               emoji: '🦸', color: '#4F46E5', category: 'fitness',   type: 'weekly', criteriaType: 'STEPS',              targetValue: 70000, coinReward: 300, order: 17 },
      { title: 'Distance Warrior',   description: 'Cover 30 km this week.',                     emoji: '🏅', color: '#8B5CF6', category: 'fitness',   type: 'weekly', criteriaType: 'DISTANCE',           targetValue: 30,    coinReward: 150, order: 18 },
      { title: 'Active Week',        description: 'Stay active for 150 minutes this week.',     emoji: '💪', color: '#EF4444', category: 'fitness',   type: 'weekly', criteriaType: 'ACTIVE_MINUTES',     targetValue: 150,   coinReward: 180, order: 19 },
      { title: 'Weekly Calorie Burn',description: 'Burn 2,000 active calories this week.',      emoji: '🔥', color: '#F97316', category: 'fitness',   type: 'weekly', criteriaType: 'CALORIES',           targetValue: 2000,  coinReward: 160, order: 20 },
      // Weekly — Hydration
      { title: 'Hydration Week',     description: 'Drink 14,000 ml of water this week.',        emoji: '🌊', color: '#0EA5E9', category: 'hydration', type: 'weekly', criteriaType: 'HYDRATION',          targetValue: 14000, coinReward: 120, order: 21 },
      // Weekly — Nutrition
      { title: '5-Day Nutrition Streak', description: 'Log meals on 5 different days this week.', emoji: '📅', color: '#10B981', category: 'nutrition', type: 'weekly', criteriaType: 'NUTRITION_DAYS',  targetValue: 5,     coinReward: 150, order: 22 },
      { title: 'Weekly Protein Goal',description: 'Log 500g of protein across all meals this week.', emoji: '💪', color: '#DC2626', category: 'nutrition', type: 'weekly', criteriaType: 'NUTRITION_PROTEIN', targetValue: 500, coinReward: 200, order: 23 },
      { title: '30-Day Egg Challenge',description: 'Log eggs in meals on 4 days this week.',   emoji: '🥚', color: '#F59E0B', category: 'nutrition', type: 'weekly', criteriaType: 'SPECIFIC_FOOD',      targetFood: 'egg',  targetValue: 4,  coinReward: 100, order: 24 },
      { title: 'Weekly Calorie Log', description: 'Log 10,000 kcal in meals across the week.', emoji: '🥗', color: '#22C55E', category: 'nutrition', type: 'weekly', criteriaType: 'NUTRITION_CALORIES', targetValue: 10000, coinReward: 130, order: 25 },
    ];

    const results = [];
    for (const c of SEED) {
      const doc = await Challenge.findOneAndUpdate(
        { title: c.title, type: c.type },
        { $set: c },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      results.push({ title: doc.title, type: doc.type, _id: doc._id });
    }

    return success(res, `Seeded ${results.length} challenges`, results);
  } catch (err) {
    next(err);
  }
};

// ─── Admin: Delete Challenge ──────────────────────────────────────────────────
const adminDeleteChallenge = async (req, res, next) => {
  try {
    const challenge = await Challenge.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false } },
      { new: true },
    );
    if (!challenge) return error(res, 'Challenge not found', 404);
    return success(res, 'Challenge deactivated', challenge);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getChallenges,
  getChallengeById,
  getChallengeConfig,
  syncChallengeProgress,
  adminUpsertChallenge,
  adminDeleteChallenge,
  seedChallenges,
};
