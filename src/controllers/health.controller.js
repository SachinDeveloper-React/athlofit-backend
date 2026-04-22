const HealthActivity = require('../models/HealthActivity.model');
const BmiRecord      = require('../models/BmiRecord.model');
const Gamification   = require('../models/Gamification.model');
const User           = require('../models/User.model');
const { success, error } = require('../utils/response');
const { buildDateRange, toDayLabel, todayISO, isConsecutiveDay } = require('../utils/date');

// ─── GET /health/weekly-steps?from=YYYY-MM-DD&to=YYYY-MM-DD ──────────────────
const getWeeklySteps = async (req, res, next) => {
  try {
    const { from, to } = req.query;

    if (!from || !to) {
      return error(res, 'from and to query params are required', 400);
    }

    // Build expected date range (fills gaps with 0)
    const dates = buildDateRange(from, to);

    // Query DB for records in range
    const records = await HealthActivity.find({
      user: req.user._id,
      date: { $gte: from, $lte: to },
    }).select('date steps');

    // Map to lookup
    const recordMap = {};
    records.forEach(r => { recordMap[r.date] = r.steps; });

    // Build response matching WeeklyStepEntry[] in app
    const data = dates.map(date => ({
      date: toDayLabel(date),       // "Mon", "Tue" etc.
      fullDate: date,
      steps: recordMap[date] ?? 0,
    }));

    return success(res, 'Weekly steps fetched', data);
  } catch (err) {
    next(err);
  }
};

// ─── POST /health/sync ────────────────────────────────────────────────────────
// Mobile app can push a daily snapshot at any time; upserts by date
const syncHealthData = async (req, res, next) => {
  try {
    const {
      date,
      steps,
      distance,
      calories,
      activeMinutes,
      heartRate,
      heartRateMin,
      heartRateMax,
      bloodPressureSystolic,
      bloodPressureDiastolic,
      hydration,
      sleepHours,
      bloodGlucose,
      weight,
      goalMet,
    } = req.body;

    const today = date || todayISO();
    const dailyGoal = req.user.dailyStepGoal || 10000;
    const isGoalMet = goalMet ?? (steps >= dailyGoal);

    await HealthActivity.findOneAndUpdate(
      { user: req.user._id, date: today },
      {
        $set: {
          steps: steps ?? 0,
          distance: distance ?? 0,
          calories: calories ?? 0,
          activeMinutes: activeMinutes ?? 0,
          heartRate: heartRate ?? 0,
          heartRateMin: heartRateMin ?? 0,
          heartRateMax: heartRateMax ?? 0,
          bloodPressureSystolic: bloodPressureSystolic ?? 0,
          bloodPressureDiastolic: bloodPressureDiastolic ?? 0,
          hydration: hydration ?? 0,
          sleepHours: sleepHours ?? 0,
          bloodGlucose: bloodGlucose ?? 0,
          weight: weight ?? 0,
          goalMet: isGoalMet,
        },
      },
      { upsert: true, new: true }
    );

    // Update streak if goal was met
    if (isGoalMet) {
      await _updateStreak(req.user._id, today);
    }

    // ── Auto-award step goal coins ────────────────────────────────────────────
    // If goal is met today and coins haven't been awarded yet, credit them now.
    const AppConfig    = require('../models/AppConfig.model');
    let cfg = await AppConfig.findOne({ key: 'global' });
    if (!cfg) cfg = await AppConfig.create({ key: 'global' });

    let gam = await Gamification.findOne({ user: req.user._id });
    if (!gam) gam = await Gamification.create({ user: req.user._id });

    // Reset daily coins counter if it's a new day
    if (gam.lastCoinDate !== today) {
      gam.coinsEarnedToday = 0;
    }

    let goalCoinsAwarded = false;

    if (isGoalMet && gam.lastCoinDate !== today) {
      // Award step goal coins automatically
      const stepGoalCoins = cfg.rewards.stepGoalCoins ?? 50;
      gam.coinsBalance = Math.round(gam.coinsBalance + stepGoalCoins);
      gam.coinsEarnedToday = Math.round((gam.coinsEarnedToday || 0) + stepGoalCoins);
      gam.lastCoinDate = today;

      if (!gam.claimHistory) gam.claimHistory = [];
      gam.claimHistory.push({
        rewardId: 'steps_daily_auto',
        amount: stepGoalCoins,
        source: 'Daily Step Goal — Auto Reward',
        createdAt: new Date(),
      });
      if (gam.claimHistory.length > 50) gam.claimHistory.shift();

      goalCoinsAwarded = true;
      await gam.save();
    } else {
      // Passive sweatcoin-style coins from distance walked
      const dailyEarnLimit = cfg.coin.dailyEarnLimit;
      const coinsPerStepKm = cfg.coin.coinsPerStepKm;
      const stepsPerKm = 1300;
      const kmWalked = (steps ?? 0) / stepsPerKm;
      const coinsEarnedToday = Math.round(Math.min(dailyEarnLimit, Math.max(0, kmWalked * coinsPerStepKm * 0.95)));

      const currentEarned = gam.coinsEarnedToday || 0;
      if (coinsEarnedToday > currentEarned) {
        const actualAdded = coinsEarnedToday - currentEarned;
        gam.coinsEarnedToday = coinsEarnedToday;
        gam.coinsBalance = Math.round(gam.coinsBalance + actualAdded);
        gam.lastCoinDate = today;
        await gam.save();
      }
    }

    return success(res, 'Health data synced', {
      goalCoinsAwarded,
      coinsBalance: gam.coinsBalance,
      stepGoalCoins: goalCoinsAwarded ? (cfg.rewards.stepGoalCoins ?? 50) : 0,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /health/history ──────────────────────────────────────────────────────
const getHealthHistory = async (req, res, next) => {
  try {
    const { from, to, limit = 30 } = req.query;

    const query = { user: req.user._id };
    if (from && to) query.date = { $gte: from, $lte: to };

    const records = await HealthActivity.find(query)
      .sort({ date: -1 })
      .limit(Number(limit));

    return success(res, 'Health history fetched', records);
  } catch (err) {
    next(err);
  }
};

// ─── GET /health/today ────────────────────────────────────────────────────────
const getTodayHealth = async (req, res, next) => {
  try {
    const today = todayISO();
    const record = await HealthActivity.findOne({ user: req.user._id, date: today });
    return success(res, 'Today health data fetched', record);
  } catch (err) {
    next(err);
  }
};

// ─── Internal: update streak ─────────────────────────────────────────────────
async function _updateStreak(userId, date) {
  const BadgeDefinition = require('../models/BadgeDefinition.model');
  const gam = await Gamification.findOne({ user: userId });
  if (!gam) return;

  const wasConsecutive = isConsecutiveDay(gam.lastActiveDate, date);
  const isSameDay = gam.lastActiveDate === date;

  if (!isSameDay) {
    if (wasConsecutive) {
      gam.streakDays += 1;
    } else {
      gam.streakDays = 1; // reset
    }
    gam.lastActiveDate = date;
    if (gam.streakDays > gam.bestStreakDays) {
      gam.bestStreakDays = gam.streakDays;
    }
    // Load active badge definitions and award any newly unlocked badges
    const badgeDefs = await BadgeDefinition.find({ isActive: true }).sort({ order: 1 });
    gam.awardBadges(badgeDefs);
    await gam.save();
  }
}

// ─── GET /health/analytics ───────────────────────────────────────────────────
// Returns real aggregated metrics from HealthActivity records.
// For each timeframe: computes chart data points, totals, and trend vs prior period.
const getAnalyticsDashboard = async (req, res, next) => {
  try {
    const { period = 'day' } = req.query;
    const timeframe = period.charAt(0).toUpperCase() + period.slice(1).toLowerCase();

    const userId = req.user._id;
    const dailyGoal = req.user.dailyStepGoal || 10000;
    const CALORIE_GOAL = 2500;
    const ACTIVITY_GOAL = 60; // mins

    // ── Helper: compute avg or sum from array of numbers (skip zeros) ───────
    const avg = (arr) => {
      const nonZero = arr.filter(v => v > 0);
      return nonZero.length ? nonZero.reduce((s, v) => s + v, 0) / nonZero.length : 0;
    };
    const sum = (arr) => arr.reduce((s, v) => s + v, 0);
    const trend = (curr, prev) => {
      if (!prev) return 0;
      return +((((curr - prev) / prev) * 100).toFixed(1));
    };
    const round1 = (n) => Math.round(n * 10) / 10;

    // ── Date helpers ─────────────────────────────────────────────────────────
    const toISO = (d) => d.toISOString().slice(0, 10);

    const now = new Date();

    let labels = [];
    let currentDates = [];  // YYYY-MM-DD strings for current period
    let priorDates = [];    // YYYY-MM-DD strings for prior period (for trend)

    switch (timeframe) {
      case 'Day': {
        // Current = today; Prior = yesterday
        const todayStr = toISO(now);
        const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
        currentDates = [todayStr];
        priorDates = [toISO(yesterday)];
        labels = ['6am', '9am', '12pm', '3pm', '6pm', '9pm'];
        break;
      }
      case 'Week': {
        // Current = last 7 days; Prior = 7 days before that
        for (let i = 6; i >= 0; i--) {
          const d = new Date(now); d.setDate(now.getDate() - i);
          currentDates.push(toISO(d));
        }
        for (let i = 13; i >= 7; i--) {
          const d = new Date(now); d.setDate(now.getDate() - i);
          priorDates.push(toISO(d));
        }
        labels = currentDates.map(dt => {
          const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          return days[new Date(dt).getDay()];
        });
        break;
      }
      case 'Month': {
        // Current = last 28 days split into 4 weeks; Prior = 28 days before that
        for (let i = 27; i >= 0; i--) {
          const d = new Date(now); d.setDate(now.getDate() - i);
          currentDates.push(toISO(d));
        }
        for (let i = 55; i >= 28; i--) {
          const d = new Date(now); d.setDate(now.getDate() - i);
          priorDates.push(toISO(d));
        }
        labels = ['W1', 'W2', 'W3', 'W4'];
        break;
      }
      case 'Year': {
        // Current = last 12 months; Prior = 12 months before that
        const curMonthStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
        const priorMonthStart = new Date(now.getFullYear(), now.getMonth() - 23, 1);
        // Build ISO dates month by month
        for (let m = 0; m < 12; m++) {
          const start = new Date(curMonthStart.getFullYear(), curMonthStart.getMonth() + m, 1);
          const end = new Date(curMonthStart.getFullYear(), curMonthStart.getMonth() + m + 1, 0);
          for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            currentDates.push(toISO(new Date(d)));
          }
        }
        for (let m = 0; m < 12; m++) {
          const start = new Date(priorMonthStart.getFullYear(), priorMonthStart.getMonth() + m, 1);
          const end = new Date(priorMonthStart.getFullYear(), priorMonthStart.getMonth() + m + 1, 0);
          for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            priorDates.push(toISO(new Date(d)));
          }
        }
        labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
          .slice(0, 12);
        // Reduce to 4 quarterly labels for chart
        labels = ['Q1', 'Q2', 'Q3', 'Q4'];
        break;
      }
      default:
        return error(res, 'Invalid analytics period requested', 400);
    }

    // ── Fetch real DB records for both periods ───────────────────────────────
    const allDates = [...currentDates, ...priorDates];
    const allRecordsRaw = await HealthActivity.find({
      user: userId,
      date: { $in: allDates },
    }).select('date steps distance calories activeMinutes heartRate heartRateMin heartRateMax bloodPressureSystolic bloodPressureDiastolic hydration goalMet');

    // Build lookup by date
    const byDate = {};
    allRecordsRaw.forEach(r => { byDate[r.date] = r; });

    const pick = (date, field) => byDate[date]?.[field] ?? 0;

    // ── Current period arrays ────────────────────────────────────────────────
    const cur = {
      steps:    currentDates.map(d => pick(d, 'steps')),
      calories: currentDates.map(d => pick(d, 'calories')),
      distance: currentDates.map(d => pick(d, 'distance')),
      time:     currentDates.map(d => pick(d, 'activeMinutes')),
      heart:    currentDates.map(d => pick(d, 'heartRate')),
      sys:      currentDates.map(d => pick(d, 'bloodPressureSystolic')),
      dia:      currentDates.map(d => pick(d, 'bloodPressureDiastolic')),
    };

    // ── Prior period arrays (for trend only) ─────────────────────────────────
    const pri = {
      steps:    priorDates.map(d => pick(d, 'steps')),
      calories: priorDates.map(d => pick(d, 'calories')),
      distance: priorDates.map(d => pick(d, 'distance')),
      time:     priorDates.map(d => pick(d, 'activeMinutes')),
      heart:    priorDates.map(d => pick(d, 'heartRate')),
    };

    // ── Build chart data sets per timeframe ──────────────────────────────────
    let chartDataSets;

    if (timeframe === 'Day') {
      // For "Day" we can't split into 6 hour-slots from daily records,
      // so we show the single current day value as a flat line across 6 points.
      const todaySteps = cur.steps[0] || 0;
      const todayCal   = cur.calories[0] || 0;
      const todayDist  = round1(cur.distance[0] || 0);
      const todayTime  = cur.time[0] || 0;
      const todayHR    = cur.heart[0] || 0;
      const todaySys   = cur.sys[0] || 0;
      // Distribute steps across 6 time points (cumulative approximation)
      const stepPoints = [0.05, 0.12, 0.30, 0.50, 0.75, 1.0].map(f => Math.round(todaySteps * f));
      const calPoints  = [0.05, 0.15, 0.35, 0.55, 0.78, 1.0].map(f => Math.round(todayCal * f));
      const distPoints = [0.05, 0.12, 0.30, 0.50, 0.75, 1.0].map(f => round1(todayDist * f));
      const timePoints = [0.05, 0.15, 0.35, 0.55, 0.78, 1.0].map(f => Math.round(todayTime * f));
      chartDataSets = {
        steps:    stepPoints,
        heart:    new Array(6).fill(todayHR || 0),
        bp:       new Array(6).fill(todaySys || 0),
        calories: calPoints,
        distance: distPoints,
        time:     timePoints,
      };
    } else if (timeframe === 'Week') {
      chartDataSets = {
        steps:    cur.steps,
        heart:    cur.heart,
        bp:       cur.sys,
        calories: cur.calories,
        distance: cur.distance.map(round1),
        time:     cur.time,
      };
    } else if (timeframe === 'Month') {
      // Group daily data into 4 weeks
      const weeks = [
        currentDates.slice(0, 7),
        currentDates.slice(7, 14),
        currentDates.slice(14, 21),
        currentDates.slice(21, 28),
      ];
      chartDataSets = {
        steps:    weeks.map(w => sum(w.map(d => pick(d, 'steps')))),
        heart:    weeks.map(w => Math.round(avg(w.map(d => pick(d, 'heartRate'))))),
        bp:       weeks.map(w => Math.round(avg(w.map(d => pick(d, 'bloodPressureSystolic'))))),
        calories: weeks.map(w => sum(w.map(d => pick(d, 'calories')))),
        distance: weeks.map(w => round1(sum(w.map(d => pick(d, 'distance'))))),
        time:     weeks.map(w => sum(w.map(d => pick(d, 'activeMinutes')))),
      };
    } else {
      // Year: group by quarter (3 months each)
      const monthGroups = [[], [], [], []]; // Q1, Q2, Q3, Q4
      currentDates.forEach(d => {
        const month = new Date(d).getMonth(); // 0-11
        const q = Math.floor(month / 3);     // 0-3
        monthGroups[q].push(d);
      });
      chartDataSets = {
        steps:    monthGroups.map(g => sum(g.map(d => pick(d, 'steps')))),
        heart:    monthGroups.map(g => Math.round(avg(g.map(d => pick(d, 'heartRate'))))),
        bp:       monthGroups.map(g => Math.round(avg(g.map(d => pick(d, 'bloodPressureSystolic'))))),
        calories: monthGroups.map(g => sum(g.map(d => pick(d, 'calories')))),
        distance: monthGroups.map(g => round1(sum(g.map(d => pick(d, 'distance'))))),
        time:     monthGroups.map(g => sum(g.map(d => pick(d, 'activeMinutes')))),
      };
    }

    // ── Compute summary metrics ──────────────────────────────────────────────
    const totalSteps    = sum(cur.steps);
    const totalCalories = sum(cur.calories);
    const totalDistance = round1(sum(cur.distance));
    const totalTime     = sum(cur.time);
    const avgHR         = Math.round(avg(cur.heart));
    const avgSys        = Math.round(avg(cur.sys));
    const avgDia        = Math.round(avg(cur.dia));
    const bpStr         = avgSys > 0 ? `${avgSys}/${avgDia}` : '—';

    const prevSteps    = sum(pri.steps);
    const prevCalories = sum(pri.calories);
    const prevDistance = round1(sum(pri.distance));
    const prevTime     = sum(pri.time);
    const prevHR       = Math.round(avg(pri.heart));

    const metrics = {
      steps:         { value: totalSteps,    trend: trend(totalSteps, prevSteps) },
      heartRate:     { value: avgHR,         trend: trend(avgHR, prevHR) },
      bloodPressure: { value: bpStr,         trend: 0 },
      calories:      { value: totalCalories, trend: trend(totalCalories, prevCalories) },
      distance:      { value: totalDistance, trend: trend(totalDistance, prevDistance) },
      activityTime:  { value: totalTime,     trend: trend(totalTime, prevTime) },
    };

    // ── Ring goals (based on per-day average vs goals) ───────────────────────
    const daysCount = currentDates.length || 1;
    const avgStepsPerDay = totalSteps / daysCount;
    const avgCalPerDay   = totalCalories / daysCount;
    const avgTimePerDay  = totalTime / daysCount;

    const rings = {
      stepsGoalPercent:    Math.min(1, round1(avgStepsPerDay / dailyGoal)),
      caloriesGoalPercent: Math.min(1, round1(avgCalPerDay / CALORIE_GOAL)),
      timeGoalPercent:     Math.min(1, round1(avgTimePerDay / ACTIVITY_GOAL)),
    };

    return success(res, 'Analytics dashboard data fetched', {
      timeframe, metrics, chartDataSets, labels, rings,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /health/analytics/sync ──────────────────────────────────────────────
const syncAnalyticsDashboard = async (req, res, next) => {
  try {
    return success(res, 'Health analytics synced from device explicitly', {
      success: true,
      message: 'Server acknowledged sync ping'
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /health/bmi ─────────────────────────────────────────────────────────
// Body: { weight: number (kg), height: number (m) }
// Calculates BMI, determines category, and saves the record.
const saveBmi = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { weight, height } = req.body;

    if (!weight || weight <= 0) return error(res, 'weight (kg) is required and must be positive', 400);
    if (!height || height <= 0) return error(res, 'height (m) is required and must be positive', 400);

    const bmi = parseFloat((weight / (height * height)).toFixed(1));

    let category;
    if (bmi < 18.5)       category = 'underweight';
    else if (bmi < 25.0)  category = 'normal';
    else if (bmi < 30.0)  category = 'overweight';
    else                   category = 'obese';

    const record = await BmiRecord.create({
      user:     userId,
      date:     todayISO(),
      weight:   parseFloat(weight.toFixed(1)),
      height:   parseFloat(height.toFixed(2)),
      bmi,
      category,
    });

    // Also update today's HealthActivity with the latest weight
    await HealthActivity.findOneAndUpdate(
      { user: userId, date: todayISO() },
      { $set: { weight: parseFloat(weight.toFixed(1)) } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Update User model with height and weight
    await User.findByIdAndUpdate(
      userId,
      { $set: { weight: parseFloat(weight.toFixed(1)), height: parseFloat((height * 100).toFixed(0)) } }
    );

    return success(res, 'BMI saved', record.toJSON(), 201);
  } catch (err) {
    next(err);
  }
};

// ─── GET /health/bmi?limit=10 ─────────────────────────────────────────────────
// Returns the most recent BMI records for the authenticated user.
const getBmiHistory = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));

    const records = await BmiRecord.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(limit);

    return success(res, 'BMI history fetched', records);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getWeeklySteps,
  syncHealthData,
  getHealthHistory,
  getTodayHealth,
  getAnalyticsDashboard,
  syncAnalyticsDashboard,
  saveBmi,
  getBmiHistory,
};
