const HealthActivity = require('../models/HealthActivity.model');
const BmiRecord      = require('../models/BmiRecord.model');
const Gamification   = require('../models/Gamification.model');
const User           = require('../models/User.model');
const { success, error } = require('../utils/response');
const { buildDateRange, toDayLabel, todayISO, isConsecutiveDay } = require('../utils/date');
const { syncChallengeProgress } = require('./challenge.controller');
const { sendPushToUser } = require('../utils/pushNotification');
const { createNotification } = require('../utils/createNotification');
const { logCoinTransaction } = require('../utils/logCoinTransaction');

// ─── Unverified user daily coin cap ──────────────────────────────────────────
function getEffectiveDailyCap(user, configMax, unverifiedCap) {
  const isVerified = user.emailVerified;
  if (!isVerified) {
    const cap = unverifiedCap ?? 50;
    return Math.min(cap, configMax);
  }
  return configMax;
}

// ─── GET /health/weekly-steps?from=YYYY-MM-DD&to=YYYY-MM-DD ──────────────────
const getWeeklySteps = async (req, res, next) => {
  try {
    const { from, to } = req.query;

    if (!from || !to) {
      return error(res, 'from and to query params are required', 400);
    }

    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
      return error(res, 'from and to must be valid ISO date strings (YYYY-MM-DD)', 400);
    }

    // Build expected date range (fills gaps with 0)
    const dates = buildDateRange(from, to);

    // Query DB for records in range
    const records = await HealthActivity.find({
      user: req.user._id,
      date: { $gte: from, $lte: to },
    }).select('date steps bonusSteps goalSnapshot');

    // Map to lookup
    const recordMap = {};
    records.forEach(r => { recordMap[r.date] = { steps: r.steps, bonusSteps: r.bonusSteps || 0, goalSnapshot: r.goalSnapshot }; });

    // Build response matching WeeklyStepEntry[] in app
    const data = dates.map(date => ({
      date: toDayLabel(date),       // "Mon", "Tue" etc.
      fullDate: date,
      steps: recordMap[date]?.steps ?? 0,
      bonusSteps: recordMap[date]?.bonusSteps ?? 0,
      // Use the goal that was active on that day; fall back to current goal
      // for days that have no record yet (future/unsynced days).
      goalSnapshot: recordMap[date]?.goalSnapshot || req.user.dailyStepGoal || 10000,
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

    // ── Apply pending step goal if effective date has arrived ─────────────────
    // When a user changes their goal, it's stored as pending and only becomes
    // the active dailyStepGoal on or after the effective date.
    if (
      req.user.pendingStepGoal &&
      req.user.pendingGoalEffectiveDate &&
      today >= req.user.pendingGoalEffectiveDate
    ) {
      await User.findByIdAndUpdate(req.user._id, {
        $set: { dailyStepGoal: req.user.pendingStepGoal },
        $unset: { pendingStepGoal: 1, pendingGoalEffectiveDate: 1 },
      });
      // Use the newly applied goal for today's sync
      req.user.dailyStepGoal = req.user.pendingStepGoal;
      req.user.pendingStepGoal = null;
      req.user.pendingGoalEffectiveDate = null;
    }

    // ── Guard: reject syncs for dates before the user's account was created ──
    // This prevents historical Health Connect / HealthKit data from leaking
    // into a newly created account (the background sync always pushes yesterday,
    // but yesterday might pre-date the account).
    const accountCreatedDate = req.user.createdAt
      ? new Date(req.user.createdAt).toISOString().slice(0, 10)
      : null;
    if (accountCreatedDate && today < accountCreatedDate) {
      return success(res, 'Skipped — date is before account creation', {
        skipped: true,
      });
    }

    const dailyGoal = req.user.dailyStepGoal || 10000;
    const isGoalMet = goalMet ?? (steps >= dailyGoal);

    // ── Merge strategy: only overwrite a field if the incoming value is
    // meaningful (> 0). This prevents a background sync that only has steps
    // from zeroing out vitals (HR, BP, glucose, weight) that were recorded
    // manually or by a different source earlier in the day.
    const existing = await HealthActivity.findOne({ user: req.user._id, date: today });

    const merge = (incoming, stored) =>
      (incoming !== undefined && incoming !== null && incoming > 0)
        ? incoming
        : (stored ?? 0);

    // Hydration supports explicit reset to 0 — unlike other fields where 0
    // means "no data from device this sync cycle", hydration 0 is a deliberate
    // user action (undo/reset). So we bypass the merge guard for it.
    const resolveHydration = (incoming, stored) =>
      (incoming !== undefined && incoming !== null && incoming === 0)
        ? 0 // explicit reset
        : merge(incoming, stored);

    // Preserve bonus steps — device only knows about walked steps, so
    // total = device steps + bonus steps credited by admin/system.
    const bonusSteps = existing?.bonusSteps || 0;
    const deviceSteps = merge(steps, (existing?.steps || 0) - bonusSteps);
    const totalSteps = deviceSteps + bonusSteps;

    // Re-evaluate goal met with total steps (walked + bonus)
    const totalGoalMet = goalMet ?? (totalSteps >= dailyGoal);

    const updateFields = {
      // Steps = walked (from device) + bonus (from admin/system)
      steps:                  totalSteps,
      bonusSteps:             bonusSteps, // preserve, don't overwrite
      distance:               merge(distance,               existing?.distance),
      calories:               merge(calories,               existing?.calories),
      activeMinutes:          merge(activeMinutes,          existing?.activeMinutes),
      // Vitals — keep existing value if incoming is 0 (device may not have
      // a reading for this sync cycle)
      heartRate:              merge(heartRate,              existing?.heartRate),
      heartRateMin:           merge(heartRateMin,           existing?.heartRateMin),
      heartRateMax:           merge(heartRateMax,           existing?.heartRateMax),
      bloodPressureSystolic:  merge(bloodPressureSystolic,  existing?.bloodPressureSystolic),
      bloodPressureDiastolic: merge(bloodPressureDiastolic, existing?.bloodPressureDiastolic),
      hydration:              resolveHydration(hydration, existing?.hydration),
      sleepHours:             merge(sleepHours,             existing?.sleepHours),
      bloodGlucose:           merge(bloodGlucose,           existing?.bloodGlucose),
      weight:                 merge(weight,                 existing?.weight),
      goalMet: totalGoalMet,
      // Snapshot the goal that was active on this day — only set once so that
      // changing the goal later does NOT retroactively alter past days.
      goalSnapshot: existing?.goalSnapshot > 0 ? existing.goalSnapshot : dailyGoal,
    };

    await HealthActivity.findOneAndUpdate(
      { user: req.user._id, date: today },
      { $set: updateFields },
      { upsert: true, new: true }
    );

    // Update streak if goal was met
    if (totalGoalMet) {
      await _updateStreak(req.user._id, today);
    }

    // ── Auto-award step goal coins ────────────────────────────────────────────
    // If goal is met today and coins haven't been awarded yet, credit them now.
    const AppConfig    = require('../models/AppConfig.model');
    let cfg = await AppConfig.findOne({ key: 'global' });
    if (!cfg) cfg = await AppConfig.create({ key: 'global' });

    let gam = await Gamification.findOne({ user: req.user._id });
    if (!gam) gam = await Gamification.create({ user: req.user._id });

    // Always update lastActiveDate when syncing today's data
    // (tracks that the user was active today, regardless of goal completion)
    const actualToday = todayISO();
    // Coins are ONLY awarded for today's actual date — never for past-day background syncs.
    // Allow a 1-day tolerance for timezone edge cases (app in UTC vs server in IST).
    const isTodaySync = (today === actualToday);
    const isNearToday = isTodaySync || (() => {
      // Check if `today` is yesterday (server time) — which could still be "today" for the user
      const d1 = new Date(`${actualToday}T00:00:00Z`);
      const d2 = new Date(`${today}T00:00:00Z`);
      return Math.abs(d1 - d2) <= 86400000; // within 24 hours
    })();
    
    if ((isTodaySync || isNearToday) && gam.lastActiveDate !== actualToday) {
      gam.lastActiveDate = actualToday;
    }

    // Reset daily coins counter ONLY when we're sure it's a new server-day.
    // Use lastCoinDate (which is set to the server's actualToday) to avoid double-resets.
    if (isTodaySync && gam.lastCoinDate !== actualToday) {
      gam.coinsEarnedToday = 0;
    }

    let goalCoinsAwarded = false;
    let awardedGoalCoins = 0;

    // ── Revert hydration reward if water was reset below goal ─────────────────
    // When the user explicitly resets hydration (sends 0), and they had already
    // claimed the daily water coins, un-claim them so the Earn Coins card
    // reflects the reverted state.
    const resolvedHydration = updateFields.hydration;
    const hydrationGoalMl = cfg.rewards?.hydrationGoalMl ?? 2000;

    if (
      isTodaySync &&
      resolvedHydration < hydrationGoalMl &&
      gam.lastWaterCoinDate === today
    ) {
      // Deduct the hydration reward coins that were previously awarded
      const hydrationCoins = cfg.rewards?.hydrationGoalCoins ?? 20;
      gam.coinsBalance = Math.max(0, Math.round(gam.coinsBalance - hydrationCoins));
      gam.coinsEarnedToday = Math.max(0, Math.round((gam.coinsEarnedToday || 0) - hydrationCoins));
      gam.lastWaterCoinDate = null; // allow re-claim when goal is met again

      // Log the reversal transaction
      logCoinTransaction({
        userId: req.user._id,
        type: 'DEDUCTED',
        amount: hydrationCoins,
        balanceAfter: gam.coinsBalance,
        source: 'HYDRATION_GOAL_REVERTED',
        description: 'Water intake reset — hydration reward reversed',
        metadata: { date: today, rewardId: 'hydration_daily' },
      });

      await gam.save();
    }

    if (isGoalMet && gam.stepGoalCoinDate !== today && isTodaySync) {
      // Award step goal coins automatically (subject to daily cap)
      const stepGoalCoins = cfg.rewards.stepGoalCoins ?? 50;
      const effectiveCap = getEffectiveDailyCap(req.user, cfg.coin.maxDailyRewards ?? 500, cfg.coin.unverifiedDailyCap);
      const remainingAllowance = effectiveCap - (gam.coinsEarnedToday || 0);
      const actualStepGoalCoins = Math.round(Math.min(stepGoalCoins, Math.max(0, remainingAllowance)));

      if (actualStepGoalCoins > 0) {
        gam.coinsBalance = Math.round(gam.coinsBalance + actualStepGoalCoins);
        gam.coinsEarnedToday = Math.round((gam.coinsEarnedToday || 0) + actualStepGoalCoins);
      }
      gam.stepGoalCoinDate = today;

      if (!gam.claimHistory) gam.claimHistory = [];
      gam.claimHistory.push({
        rewardId: 'steps_daily_auto',
        amount: actualStepGoalCoins,
        source: 'Daily Step Goal — Auto Reward',
        createdAt: new Date(),
      });
      if (gam.claimHistory.length > 50) gam.claimHistory.shift();

      goalCoinsAwarded = actualStepGoalCoins > 0;
      awardedGoalCoins = actualStepGoalCoins;
      await gam.save();

      // Log coin transaction
      if (actualStepGoalCoins > 0) {
        logCoinTransaction({
          userId: req.user._id,
          type: 'EARNED',
          amount: actualStepGoalCoins,
          balanceAfter: gam.coinsBalance,
          source: 'DAILY_STEP_GOAL_AUTO',
          description: `Daily Step Goal — ${dailyGoal.toLocaleString()} steps reached`,
          metadata: { steps: steps ?? 0, date: today, rewardId: 'steps_daily_auto' },
        });
      }

      // ── Persist + push: step goal reached ──────────────────────────────
      createNotification(req.user._id, {
        type:    'GOAL',
        title:   '🎯 Daily Step Goal Reached!',
        message: `You hit your ${dailyGoal.toLocaleString()} step goal and earned ${actualStepGoalCoins} coins!`,
        data:    { screen: 'Steps' },
      });
    } else if (!isGoalMet) {
      // Passive step-based coins: Math.floor(steps / 100) * rate_per_100_steps
      // Coins accumulate as the user walks, but we only LOG a transaction
      // every 3 hours (or at end-of-day 23:59:59) to avoid duplicate entries.
      //
      // The balance is still updated on every sync (so the user sees live coins),
      // but the CoinTransaction is batched into 3-hour windows.
      //
      // IMPORTANT: Only update coinsEarnedToday/lastCoinDate for TODAY's date.
      const isTodaySyncPassive = isTodaySync;

      if (isTodaySyncPassive) {
        const dailyEarnLimit = getEffectiveDailyCap(req.user, cfg.coin.dailyEarnLimit, cfg.coin.unverifiedDailyCap);
        const rate = cfg.coin_config?.steps?.rate_per_100_steps ?? 0.5;
        const coinsEarnedToday = parseFloat(Math.min(dailyEarnLimit, Math.max(0, Math.floor((steps ?? 0) / 100) * rate)).toFixed(2));

        const currentEarned = gam.coinsEarnedToday || 0;
        if (coinsEarnedToday > currentEarned) {
          const actualAdded = parseFloat((coinsEarnedToday - currentEarned).toFixed(2));
          gam.coinsEarnedToday = coinsEarnedToday;
          gam.coinsBalance = parseFloat((gam.coinsBalance + actualAdded).toFixed(2));
          gam.lastCoinDate = actualToday;
          await gam.save();

          // ── 3-hour throttle for transaction logging ─────────────────────
          // Only log a PASSIVE_STEPS CoinTransaction if:
          //   1. At least 3 hours have passed since the last logged transaction, OR
          //   2. It's near end-of-day (23:00+) and we haven't logged since 21:00
          const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
          const now = new Date();
          const lastLogTime = gam.lastPassiveCoinTime ? new Date(gam.lastPassiveCoinTime).getTime() : 0;
          const timeSinceLastLog = now.getTime() - lastLogTime;
          const currentHour = now.getHours();

          // End-of-day check: if it's 23:xx, ensure we get a final entry
          const isEndOfDay = currentHour >= 23;
          const lastLogHour = gam.lastPassiveCoinTime ? new Date(gam.lastPassiveCoinTime).getHours() : -1;
          const lastLogDate = gam.lastPassiveCoinTime
            ? new Date(gam.lastPassiveCoinTime).toISOString().slice(0, 10)
            : null;
          const isNewDay = lastLogDate !== actualToday;

          const shouldLogTransaction =
            isNewDay ||                                    // First transaction of the day
            timeSinceLastLog >= THREE_HOURS_MS ||          // 3 hours elapsed
            (isEndOfDay && lastLogHour < 23);             // End-of-day final entry

          if (shouldLogTransaction) {
            const previousSteps = gam.lastPassiveCoinSteps || 0;
            const currentSteps = steps ?? 0;
            const stepDelta = currentSteps - previousSteps;

            // Skip logging if steps decreased (can happen when switching from
            // inflated Health Connect value to accurate native sensor value).
            // Just update the marker so the next log starts from the correct baseline.
            if (stepDelta <= 0) {
              gam.lastPassiveCoinSteps = currentSteps;
              gam.lastPassiveCoinTime = now;
              await gam.save();
            } else {
              logCoinTransaction({
                userId: req.user._id,
                type: 'EARNED',
                amount: actualAdded,
                balanceAfter: gam.coinsBalance,
                source: 'PASSIVE_STEPS',
                description: `Step Coins — ${previousSteps.toLocaleString()} → ${currentSteps.toLocaleString()} = ${stepDelta.toLocaleString()} steps`,
                metadata: { steps: currentSteps, previousSteps, stepDelta, date: today },
              });

              // Update throttle markers
              gam.lastPassiveCoinTime = now;
              gam.lastPassiveCoinSteps = currentSteps;
              await gam.save();
            }
          }
        }
      }
    }

    // Ensure lastActiveDate is persisted even if no coins were added this sync
    if (isTodaySync && gam.isModified('lastActiveDate')) {
      await gam.save();
    }

    // Await challenge sync so we can include newly completed challenges in the response
    const { newlyCompleted } = await syncChallengeProgress(req.user._id).catch(() => ({ newlyCompleted: [] }));

    return success(res, 'Health data synced', {
      goalCoinsAwarded,
      coinsBalance: gam.coinsBalance,
      stepGoalCoins: awardedGoalCoins,
      bonusSteps,       // bonus steps credited for today (so app can show total)
      totalSteps,       // walked + bonus combined
      newlyCompleted,   // array of { title, emoji, coinReward }
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

  let dirty = false;

  if (!isSameDay) {
    if (!gam.lastActiveDate) {
      // First-ever sync or lastActiveDate was cleared — preserve existing streak
      // rather than resetting it. Only set lastActiveDate going forward.
      gam.lastActiveDate = date;
      dirty = true;
      if (gam.streakDays === 0) {
        gam.streakDays = 1;
        dirty = true;
      }
    } else if (wasConsecutive) {
      gam.streakDays += 1;
      gam.lastActiveDate = date;
      dirty = true;

      // Grant freeze/life protections after streak grows.
      const { getStreakConfig, grantProtections } = require('../utils/streak');
      const sCfg = await getStreakConfig();
      grantProtections(gam, sCfg);
    } else {
      // Known gap — attempt freeze/life protection before breaking.
      const { getStreakConfig, attemptProtect } = require('../utils/streak');
      const sCfg = await getStreakConfig();
      const protection = attemptProtect(gam, sCfg);

      if (protection.protected) {
        // Streak saved! Mark today as active, do NOT reset.
        gam.lastActiveDate = date;
      } else {
        // Streak broken — attemptProtect already set streakDays to 0.
        // Now start a new streak at 1 for today's activity.
        gam.streakDays = 1;
        gam.lastActiveDate = date;

        // Send motivational push notification (fire-and-forget).
        try {
          createNotification(userId, {
            type: 'STREAK',
            title: "💪 Don't worry — start fresh!",
            message: 'Your streak broke, but every step counts. Get back on track today!',
            data: { screen: 'Tracker' },
          });
        } catch (_) { /* non-critical */ }
      }
      dirty = true;
    }

    if (gam.streakDays > gam.bestStreakDays) {
      gam.bestStreakDays = gam.streakDays;
      dirty = true;
    }
    // Load active badge definitions and award any newly unlocked badges
    const badgeDefs = await BadgeDefinition.find({ isActive: true }).sort({ order: 1 });
    const prevUnlocked = new Set((gam.badgeList || []).filter(b => b.unlockedAt).map(b => b.key));
    gam.awardBadges(badgeDefs);
    // Check if awardBadges changed anything
    const newlyUnlocked = badgeDefs.filter(def => {
      const badge = (gam.badgeList || []).find(b => b.key === def.key);
      return badge?.unlockedAt && !prevUnlocked.has(def.key);
    });
    if (newlyUnlocked.length > 0) dirty = true;

    if (dirty) await gam.save();

    // Push for any badge newly unlocked this sync
    for (const def of newlyUnlocked) {
      createNotification(userId, {
        type:    'GOAL',
        title:   `${def.emoji} Badge Unlocked: ${def.title}!`,
        message: `You hit a ${def.threshold}-day streak and earned ${def.coinReward} coins!`,
        data:    { screen: 'Achievements' },
      });
    }
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
      // Year: group by quarter using RELATIVE index within the 12-month window.
      // BUG-019: Using absolute getMonth() breaks for windows spanning two calendar
      // years (e.g. May 2024–Apr 2025). Use position in currentDates array instead.
      const monthGroups = [[], [], [], []]; // Q1, Q2, Q3, Q4
      currentDates.forEach((d, relativeIndex) => {
        const q = Math.floor(relativeIndex / Math.ceil(currentDates.length / 4));
        const safeQ = Math.min(q, 3); // clamp to 0-3
        monthGroups[safeQ].push(d);
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

    const record = await BmiRecord.findOneAndUpdate(
      { user: userId, date: todayISO() },
      {
        $set: {
          weight:   parseFloat(weight.toFixed(1)),
          height:   parseFloat((height * 100).toFixed(1)),
          bmi,
          category,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

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

// ─── GET /health/calendar?year=YYYY&month=MM ─────────────────────────────────
// Returns per-day step data for a given month, plus completed-days count.
// Used by the Calendar Indicator on the Analytics screen.
const getCalendarActivity = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const dailyGoal = req.user.dailyStepGoal || 10000;

    const now = new Date();
    const year  = parseInt(req.query.year  || String(now.getFullYear()), 10);
    const month = parseInt(req.query.month || String(now.getMonth() + 1), 10); // 1-based

    if (month < 1 || month > 12) return error(res, 'month must be 1–12', 400);

    // Build YYYY-MM-DD range for the requested month
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate(); // day 0 of next month = last day of this month
    const to   = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const records = await HealthActivity.find({
      user: userId,
      date: { $gte: from, $lte: to },
    }).select('date steps goalMet').lean();

    // Build a map for O(1) lookup
    const recordMap = {};
    records.forEach(r => { recordMap[r.date] = { steps: r.steps || 0, goalMet: r.goalMet || false }; });

    // Build full month array (all days, even those with no data)
    const days = [];
    for (let d = 1; d <= lastDay; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const rec = recordMap[dateStr];
      const steps = rec?.steps ?? 0;
      const goalMet = rec?.goalMet ?? false;
      // Intensity: 0 = no data, 1 = low (<25%), 2 = medium (<50%), 3 = high (<100%), 4 = goal met
      let intensity = 0;
      if (steps > 0) {
        const pct = steps / dailyGoal;
        if (goalMet || pct >= 1)      intensity = 4;
        else if (pct >= 0.75)         intensity = 3;
        else if (pct >= 0.5)          intensity = 2;
        else                          intensity = 1;
      }
      days.push({ date: dateStr, steps, goalMet, intensity });
    }

    // Count days where goal was met
    const completedDays = days.filter(d => d.goalMet).length;
    // Count days with any activity
    const activeDays = days.filter(d => d.steps > 0).length;

    // Build list of months from user's account creation to now
    const user = await User.findById(userId).select('createdAt').lean();
    const accountCreatedAt = user?.createdAt ? new Date(user.createdAt) : new Date();
    const months = [];
    const cursor = new Date(accountCreatedAt.getFullYear(), accountCreatedAt.getMonth(), 1);
    const endMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    while (cursor <= endMonth) {
      months.push({
        year:  cursor.getFullYear(),
        month: cursor.getMonth() + 1, // 1-based
        label: cursor.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    return success(res, 'Calendar activity fetched', {
      year,
      month,
      dailyGoal,
      completedDays,
      activeDays,
      totalDays: lastDay,
      days,
      availableMonths: months,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /health/period-stats ─────────────────────────────────────────────────
// Returns step totals + change vs prior equivalent period for 7 / 14 / 30 days.
// Used by the Period Stats card on the Analytics screen.
const getPeriodStats = async (req, res, next) => {
  try {
    const userId    = req.user._id;
    const now       = new Date();
    const toISO     = (d) => d.toISOString().slice(0, 10);
    const todayStr  = toISO(now);

    // Build date string N days ago
    const daysAgo = (n) => {
      const d = new Date(now);
      d.setDate(now.getDate() - n);
      return toISO(d);
    };

    // Fetch the last 60 days in one query — covers all three periods + their priors
    const from60 = daysAgo(59); // 60 days inclusive
    const records = await HealthActivity.find({
      user: userId,
      date: { $gte: from60, $lte: todayStr },
    }).select('date steps').lean();

    // Build O(1) lookup: date → steps
    const stepMap = {};
    records.forEach(r => { stepMap[r.date] = r.steps || 0; });

    const sumRange = (startDaysAgo, endDaysAgo) => {
      let total = 0;
      for (let i = endDaysAgo; i >= startDaysAgo; i--) {
        total += stepMap[daysAgo(i)] ?? 0;
      }
      return total;
    };

    // ── 7-day period ──────────────────────────────────────────────────────────
    const steps7     = sumRange(0, 6);   // last 7 days  (today = daysAgo(0))
    const steps7prev = sumRange(7, 13);  // prior 7 days
    const change7    = steps7 - steps7prev;

    // ── 14-day period ─────────────────────────────────────────────────────────
    const steps14     = sumRange(0, 13);
    const steps14prev = sumRange(14, 27);
    const change14    = steps14 - steps14prev;

    // ── 30-day period ─────────────────────────────────────────────────────────
    const steps30     = sumRange(0, 29);
    const steps30prev = sumRange(30, 59);
    const change30    = steps30 - steps30prev;

    return success(res, 'Period stats fetched', {
      periods: [
        {
          label:      '7 Days',
          days:       7,
          totalSteps: steps7,
          change:     change7,
          prevTotal:  steps7prev,
        },
        {
          label:      '14 Days',
          days:       14,
          totalSteps: steps14,
          change:     change14,
          prevTotal:  steps14prev,
        },
        {
          label:      '30 Days',
          days:       30,
          totalSteps: steps30,
          change:     change30,
          prevTotal:  steps30prev,
        },
      ],
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /health/day-detail?date=YYYY-MM-DD ──────────────────────────────────
// Returns full health snapshot for a single day — used by StepDetailScreen.
const getDayDetail = async (req, res, next) => {
  try {
    const userId    = req.user._id;
    const date      = req.query.date || todayISO();

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return error(res, 'date must be YYYY-MM-DD', 400);
    }

    const record = await HealthActivity.findOne({ user: userId, date }).lean();

    // Use the goal that was active on that specific day (goalSnapshot).
    // Fall back to the user's current goal only if the record pre-dates the
    // goalSnapshot field or has no record at all.
    const dailyGoal = (record?.goalSnapshot > 0 ? record.goalSnapshot : null)
      ?? req.user.dailyStepGoal
      ?? 10000;

    const steps          = record?.steps          ?? 0;
    const calories       = record?.calories       ?? 0;
    const distance       = record?.distance       ?? 0;
    const activeMinutes  = record?.activeMinutes  ?? 0;
    const heartRate      = record?.heartRate      ?? 0;
    const heartRateMin   = record?.heartRateMin   ?? 0;
    const heartRateMax   = record?.heartRateMax   ?? 0;
    const hydration      = record?.hydration      ?? 0;
    const sleepHours     = record?.sleepHours     ?? 0;
    const bloodGlucose   = record?.bloodGlucose   ?? 0;
    const weight         = record?.weight         ?? 0;
    const goalMet        = record?.goalMet        ?? false;

    const progressPct = dailyGoal > 0 ? Math.min(100, Math.round((steps / dailyGoal) * 100)) : 0;

    // Derive intensity level (same logic as calendar)
    let intensity = 0;
    if (steps > 0) {
      const pct = steps / dailyGoal;
      if (goalMet || pct >= 1)  intensity = 4;
      else if (pct >= 0.75)     intensity = 3;
      else if (pct >= 0.5)      intensity = 2;
      else                      intensity = 1;
    }

    return success(res, 'Day detail fetched', {
      date,
      dailyGoal,
      steps,
      calories,
      distance,
      activeMinutes,
      heartRate,
      heartRateMin,
      heartRateMax,
      hydration,
      sleepHours,
      bloodGlucose,
      weight,
      goalMet,
      progressPct,
      intensity,
      hasData: !!record,
    });
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
  getCalendarActivity,
  getPeriodStats,
  getDayDetail,
  saveBmi,
  getBmiHistory,
};
