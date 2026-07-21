// src/controllers/gamification.controller.js
const Gamification = require('../models/Gamification.model');
const BadgeDefinition = require('../models/BadgeDefinition.model');
const HealthActivity = require('../models/HealthActivity.model');
const Order = require('../models/Order.model');
const AppConfig = require('../models/AppConfig.model');
const CoinTransaction = require('../models/CoinTransaction.model');
const { success, error } = require('../utils/response');
const { todayISO } = require('../utils/date');
const { sendPushToUser } = require('../utils/pushNotification');
const { createNotification } = require('../utils/createNotification');
const { logCoinTransaction } = require('../utils/logCoinTransaction');
const { isCoinBlocked } = require('../utils/cheatPenalty');

// ─── Helper: load live config (falls back to defaults if not seeded) ──────────
async function getLiveConfig() {
  let cfg = await AppConfig.findOne({ key: 'global' });
  if (!cfg) cfg = await AppConfig.create({ key: 'global' });
  return cfg;
}

// ─── Helper: get effective daily coin cap based on user verification status ───
// Unverified users (email not verified) get a lower cap from config.
function getEffectiveDailyCap(user, configMax, unverifiedCap) {
  const isVerified = user.emailVerified;
  if (!isVerified) {
    const cap = unverifiedCap ?? 50; // fallback if config not set
    return Math.min(cap, configMax);
  }
  return configMax;
}

// ─── Helper: load active badge defs + ensure user record is migrated ──────────
const loadBadgeDefs = async () => {
  return BadgeDefinition.find({ isActive: true }).sort({ order: 1 });
};

const ensureGamDoc = async (userId) => {
  let gam = await Gamification.findOne({ user: userId });
  if (!gam) {
    gam = await Gamification.create({ user: userId });
  }
  return gam;
};

const migrateAndSave = async (gam) => {
  // One-time migration from old badges object → new badgeList array
  gam.migrateOldBadges();
  await gam.save();
};

// ─── GET /gamification/me ─────────────────────────────────────────────────────
const getGamification = async (req, res, next) => {
  try {
    const gam = await ensureGamDoc(req.user._id);

    // ── Anti-cheat: include coin block status ──────────────────────────────────
    const coinBlockStatus = isCoinBlocked(req.user);

    return success(res, 'Gamification data fetched', {
      coinsBalance: gam.coinsBalance,
      streakDays: gam.streakDays,
      bestStreakDays: gam.bestStreakDays,
      lastActiveDate: gam.lastActiveDate,
      coinsEarnedToday: gam.coinsEarnedToday,
      lastCoinDate: gam.lastCoinDate,
      // Coin block penalty info (null if not blocked)
      coinBlocked: coinBlockStatus.isBlocked ? {
        blocked: true,
        blockedUntil: coinBlockStatus.blockedUntil,
        daysRemaining: coinBlockStatus.daysRemaining,
        message: `Your coin earnings are blocked until ${coinBlockStatus.blockedUntil.toISOString().slice(0, 10)} due to suspicious step activity.`,
      } : null,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /gamification/streaks ────────────────────────────────────────────────
const getStreaks = async (req, res, next) => {
  try {
    const [gam, badgeDefs] = await Promise.all([
      ensureGamDoc(req.user._id),
      loadBadgeDefs(),
    ]);

    // Auto-migrate if old schema detected
    gam.migrateOldBadges();
    await gam.save();

    const data = {
      streakDays: gam.streakDays,
      bestStreakDays: gam.bestStreakDays,
      nextBadgeAt: gam.getNextBadgeAt(badgeDefs),
      badges: gam.getBadgeList(badgeDefs),
    };

    return success(res, 'Streaks fetched', data);
  } catch (err) {
    next(err);
  }
};

// ─── POST /gamification/sync ──────────────────────────────────────────────────
const syncGamification = async (req, res, next) => {
  try {
    const {
      coinsEarnedToday,
      streakDays,
      bestStreakDays,
      lastActiveDate,
      lastCoinDate,
    } = req.body;

    const today = todayISO();

    const [gam, badgeDefs] = await Promise.all([
      ensureGamDoc(req.user._id),
      loadBadgeDefs(),
    ]);

    gam.migrateOldBadges();

    // streakDays: only accept the client value if it's strictly higher than
    // what the server already recorded. _updateStreak (called during health/sync)
    // is the authoritative writer; we must not let a stale client value
    // overwrite a server-incremented streak.
    if (streakDays !== undefined && streakDays > gam.streakDays) {
      gam.streakDays = streakDays;
    }
    if (bestStreakDays !== undefined && bestStreakDays > gam.bestStreakDays) {
      gam.bestStreakDays = bestStreakDays;
    }
    if (lastActiveDate !== undefined) {
      // BUG-028: Validate lastActiveDate — must be a valid ISO date and not in the future
      const d = new Date(lastActiveDate);
      if (isNaN(d.getTime()) || lastActiveDate > today) {
        return error(res, 'lastActiveDate must be a valid ISO date not in the future', 400);
      }
      gam.lastActiveDate = lastActiveDate;
    }
    if (lastCoinDate !== undefined) gam.lastCoinDate = lastCoinDate;
    if (coinsEarnedToday !== undefined && lastCoinDate === today) {
      gam.coinsEarnedToday = coinsEarnedToday;
    }

    // Re-check badges based on incoming streakDays
    gam.awardBadges(badgeDefs);

    await gam.save();

    return success(res, 'Gamification synced');
  } catch (err) {
    next(err);
  }
};

// ─── POST /gamification/coins/earn ───────────────────────────────────────────
// POST /gamification/coins/earn — award the DAILY STEP GOAL reward.
//
// SECURITY + CORRECTNESS: the coin amount is computed SERVER-SIDE from config
// and the goal is verified against the user's stored steps. The client no
// longer dictates how many coins to add (the old `coinsToAdd` body param is
// ignored). Idempotency shares `stepGoalCoinDate` with the health-sync
// auto-award so the goal can be rewarded at most ONCE per day, regardless of
// whether the app hits this endpoint, claimReward, or relies on the auto-award.
const earnCoins = async (req, res, next) => {
  try {
    // ── Anti-cheat: block coin earning if user is penalized ──────────────────
    const coinBlockStatus = isCoinBlocked(req.user);
    if (coinBlockStatus.isBlocked) {
      return error(res, `Coin earnings are blocked until ${coinBlockStatus.blockedUntil.toISOString().slice(0, 10)} due to suspicious step activity. ${coinBlockStatus.daysRemaining} days remaining.`, 403);
    }

    const today = todayISO();
    const [gam, cfg] = await Promise.all([ensureGamDoc(req.user._id), getLiveConfig()]);

    // Feature toggle
    const stepGoalEnabled = cfg.coin_config?.rewards?.daily_step_goal_reached?.enabled ?? true;
    if (!stepGoalEnabled) {
      return error(res, 'Daily step goal reward is currently disabled', 400);
    }

    // Verify the goal is actually met using SERVER-side stored steps.
    const todayActivity = await HealthActivity.findOne({ user: req.user._id, date: today });
    const todaySteps = todayActivity?.steps ?? 0;
    const dailyGoal = req.user.dailyStepGoal || 10000;
    if (todaySteps < dailyGoal) {
      return error(res, 'Reward threshold not yet reached', 400);
    }

    // Idempotency: shared with the health-sync auto award.
    if (gam.stepGoalCoinDate === today) {
      return success(res, 'Daily step goal already rewarded today', {
        coinsBalance: gam.coinsBalance,
        coinsEarnedToday: gam.coinsEarnedToday,
        alreadyClaimed: true,
      });
    }

    // Reward amount is SERVER-defined, not client-supplied.
    const stepGoalCoins =
      cfg.coin_config?.rewards?.daily_step_goal_reached?.coin_value ?? cfg.rewards.stepGoalCoins ?? 50;

    // Atomic award — only one caller can flip stepGoalCoinDate for today.
    const MAX_DAILY_COINS = getEffectiveDailyCap(req.user, cfg.coin.maxDailyRewards, cfg.coin.unverifiedDailyCap);
    const remainingAllowance = Math.max(0, MAX_DAILY_COINS - (gam.coinsEarnedToday || 0));
    const actualCoins = Math.round(Math.min(stepGoalCoins, remainingAllowance));

    const awarded = await Gamification.findOneAndUpdate(
      { user: req.user._id, $or: [{ stepGoalCoinDate: { $ne: today } }, { stepGoalCoinDate: null }] },
      {
        $set: { stepGoalCoinDate: today },
        $inc: { coinsBalance: actualCoins, coinsEarnedToday: actualCoins },
        $push: {
          claimHistory: {
            $each: [{ rewardId: 'steps_daily_card', amount: actualCoins, source: 'Daily Step Reward', createdAt: new Date() }],
            $slice: -50,
          },
        },
      },
      { new: true }
    );

    if (!awarded) {
      // Lost the race — another request already rewarded the goal today.
      const fresh = await Gamification.findOne({ user: req.user._id });
      return success(res, 'Daily step goal already rewarded today', {
        coinsBalance: fresh?.coinsBalance ?? gam.coinsBalance,
        coinsEarnedToday: fresh?.coinsEarnedToday ?? gam.coinsEarnedToday,
        alreadyClaimed: true,
      });
    }

    if (actualCoins > 0) {
      logCoinTransaction({
        userId: req.user._id,
        type: 'EARNED',
        amount: actualCoins,
        balanceAfter: awarded.coinsBalance,
        source: 'DAILY_STEP_GOAL',
        description: `Daily Step Reward — ${actualCoins} coins`,
        metadata: { rewardId: 'steps_daily_card', date: today, steps: todaySteps },
      });
    }

    return success(res, `Earned ${actualCoins} coins`, {
      coinsBalance: awarded.coinsBalance,
      coinsEarnedToday: awarded.coinsEarnedToday,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /gamification/leaderboard ───────────────────────────────────────────
const getLeaderboard = async (req, res, next) => {
  try {
    const [top, badgeDefs] = await Promise.all([
      Gamification.find()
        .sort({ coinsBalance: -1 })
        .limit(20)
        .populate('user', 'name avatarUrl'),
      loadBadgeDefs(),
    ]);

    const data = top
      .filter(g => g.user != null)
      .map((g, i) => ({
      rank: i + 1,
      userId: g.user._id,
      name: g.user.name,
      avatarUrl: g.user.avatarUrl,
      coinsBalance: g.coinsBalance,
      streakDays: g.streakDays,
      badgesCount: g.getBadgeList(badgeDefs).filter(b => b.unlocked).length,
    }));

    return success(res, 'Leaderboard fetched', data);
  } catch (err) {
    next(err);
  }
};

// ─── GET /gamification/coins/data ────────────────────────────────────────────
const getCoinData = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const today = todayISO();

    // ── Pagination params ─────────────────────────────────────────────────────
    const page  = Math.max(1, parseInt(req.query.page  ?? '1', 10));
    const limit = Math.min(50, parseInt(req.query.limit ?? '20', 10));
    const skip  = (page - 1) * limit;

    const [gam, badgeDefs, cfg] = await Promise.all([
      ensureGamDoc(userId),
      loadBadgeDefs(),
      getLiveConfig(),
    ]);

    gam.migrateOldBadges();

    // ── Fetch transactions from CoinTransaction collection (primary) ──────────
    const [coinTxns, coinTxnTotal] = await Promise.all([
      CoinTransaction.find({ user: userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CoinTransaction.countDocuments({ user: userId }),
    ]);

    let transactions;
    let total;

    if (coinTxnTotal > 0) {
      // Use the new CoinTransaction collection.
      // Normalise types for the app UI: REFUND shows as a credit (EARNED),
      // DEDUCTED shows as a debit (SPENT).
      transactions = coinTxns.map(t => ({
        id: t._id.toString(),
        type: t.type === 'REFUND' ? 'EARNED' : (t.type === 'DEDUCTED' ? 'SPENT' : t.type),
        amount: t.amount,
        source: t.description,
        createdAt: t.createdAt.toISOString(),
        balanceAfter: t.balanceAfter,
        category: t.source,
      }));
      total = coinTxnTotal;
    } else {
      // ── Legacy fallback: assemble from HealthActivity + Order + claimHistory ─
      const [allOrders, allActivities] = await Promise.all([
        Order.find({ user: userId, totalCoins: { $gt: 0 }, paymentMethod: 'COIN_PURCHASE' })
          .sort({ createdAt: -1 })
          .select('totalCoins totalPrice createdAt _id paymentMethod'),
        HealthActivity.find({ user: userId, goalMet: true })
          .sort({ date: -1 })
          .select('date steps calories goalMet coinsEarned'),
      ]);

      const allTransactions = [
        ...allActivities.map(a => ({
          id: `act_${a._id}`,
          type: 'EARNED',
          amount: a.coinsEarned || 10,
          source: `Passive Step Coins — ${a.steps.toLocaleString()} steps`,
          createdAt: new Date(a.date).toISOString(),
        })),
        ...allOrders.map(o => ({
          id: `ord_${o._id}`,
          type: 'SPENT',
          amount: o.totalCoins,
          source: `Shop Purchase — Order #${o._id.toString().slice(-6).toUpperCase()}`,
          createdAt: o.createdAt.toISOString(),
        })),
        ...(gam.claimHistory || []).map(c => ({
          id: `claim_${c._id}`,
          type: 'EARNED',
          amount: c.amount,
          source: c.source || `Claimed ${c.rewardId}`,
          createdAt: c.createdAt.toISOString(),
        })),
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      total = allTransactions.length;
      transactions = allTransactions.slice(skip, skip + limit);
    }

    const totalPages = Math.ceil(total / limit) || 1;

    // ── Build claimable rewards ───────────────────────────────────────────────
    const todayActivity = await HealthActivity.findOne({ user: userId, date: today });
    const todaySteps = todayActivity?.steps ?? 0;
    const todayWater = todayActivity?.hydration ?? 0;
    const streakDays = gam.streakDays ?? 0;
    const dailyGoal  = req.user.dailyStepGoal || 10000;

    const streakClaimable = badgeDefs.map(def => ({
      id: `streak_${def.key}`,
      title: `Complete ${def.threshold}-Day Streak (${def.title})`,
      threshold: def.threshold,
      reward: def.coinReward,
      currentValue: streakDays,
      isClaimed: gam.isBadgeUnlocked(def.key),
    }));

    const claimable = [
      {
        id: 'steps_daily',
        title: `Walk ${dailyGoal.toLocaleString()} Steps`,
        threshold: dailyGoal,
        reward: cfg.rewards.stepGoalCoins,
        currentValue: todaySteps,
        isClaimed: todaySteps >= dailyGoal && gam.stepGoalCoinDate === today,
      },
      {
        id: 'hydration_daily',
        title: `Daily Water Goal (${cfg.rewards.hydrationGoalMl}ml)`,
        threshold: cfg.rewards.hydrationGoalMl,
        reward: cfg.rewards.hydrationGoalCoins,
        currentValue: todayWater,
        isClaimed: gam.lastWaterCoinDate === today,
      },
      ...streakClaimable,
    ];

    await gam.save();

    // ── Anti-cheat: include coin block status ──────────────────────────────────
    const coinBlockStatus = isCoinBlocked(req.user);

    return success(res, 'Coin data fetched', {
      balance: gam.coinsBalance,
      transactions,
      claimable,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages,
      },
      // Coin block penalty info (null if not blocked)
      coinBlocked: coinBlockStatus.isBlocked ? {
        blocked: true,
        blockedUntil: coinBlockStatus.blockedUntil,
        daysRemaining: coinBlockStatus.daysRemaining,
        message: `Your coin earnings are blocked until ${coinBlockStatus.blockedUntil.toISOString().slice(0, 10)} due to suspicious step activity.`,
      } : null,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /gamification/coins/claim ──────────────────────────────────────────
const claimReward = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { rewardId } = req.body;
    const today = todayISO();

    if (!rewardId) return error(res, 'rewardId is required', 400);

    // ── Anti-cheat: block coin claiming if user is penalized ─────────────────
    const coinBlockStatus = isCoinBlocked(req.user);
    if (coinBlockStatus.isBlocked) {
      return error(res, `Coin claims are blocked until ${coinBlockStatus.blockedUntil.toISOString().slice(0, 10)} due to suspicious step activity. ${coinBlockStatus.daysRemaining} days remaining.`, 403);
    }

    const [gam, badgeDefs, cfg] = await Promise.all([
      ensureGamDoc(userId),
      loadBadgeDefs(),
      getLiveConfig(),
    ]);

    gam.migrateOldBadges();

    const todayActivity = await HealthActivity.findOne({ user: userId, date: today });
    const todaySteps = todayActivity?.steps ?? 0;
    const todayWater = todayActivity?.hydration ?? 0;
    const dailyGoal = req.user.dailyStepGoal || 10000;

    // Early return if steps_daily reward is disabled via coin_config
    if (rewardId === 'steps_daily') {
      const stepGoalEnabled = cfg.coin_config?.rewards?.daily_step_goal_reached?.enabled ?? true;
      if (!stepGoalEnabled) {
        return error(res, 'Daily step goal reward is currently disabled', 400);
      }
    }

    // Build dynamic reward map from DB config
    const REWARDS = {
      steps_daily: {
        title: `Walk ${dailyGoal.toLocaleString()} Steps`,
        reward: cfg.coin_config?.rewards?.daily_step_goal_reached?.coin_value ?? cfg.rewards.stepGoalCoins,
        isMet: () => {
          const enabled = cfg.coin_config?.rewards?.daily_step_goal_reached?.enabled ?? true;
          if (!enabled) return false;
          return todaySteps >= dailyGoal;
        },
        // Share the SAME idempotency key as the health-sync auto award and
        // earnCoins so the daily step goal is rewarded at most once per day.
        isAlreadyClaimed: () => gam.stepGoalCoinDate === today,
        onClaim: () => { gam.stepGoalCoinDate = today; },
      },
      hydration_daily: {
        title: `Daily Water Goal (${cfg.rewards.hydrationGoalMl}ml)`,
        reward: cfg.rewards.hydrationGoalCoins,
        isMet: () => todayWater >= cfg.rewards.hydrationGoalMl,
        isAlreadyClaimed: () => gam.lastWaterCoinDate === today,
        onClaim: () => { gam.lastWaterCoinDate = today; },
      },
    };

    // Add dynamic streak badge rewards from DB
    for (const def of badgeDefs) {
      const id = `streak_${def.key}`;
      REWARDS[id] = {
        title: `${def.threshold}-Day Streak (${def.title})`,
        reward: def.coinReward,
        isMet: () => gam.streakDays >= def.threshold,
        isAlreadyClaimed: () => gam.isBadgeUnlocked(def.key),
        onClaim: () => { gam.unlockBadge(def.key); },
      };
    }

    const rewardDef = REWARDS[rewardId];
    if (!rewardDef) return error(res, 'Unknown reward ID', 400);
    if (!rewardDef.isMet()) return error(res, 'Reward threshold not yet reached', 400);
    if (rewardDef.isAlreadyClaimed()) return error(res, 'Reward already claimed', 400);

    // BUG-025: apply daily coin cap before awarding streak badge coins
    const MAX_DAILY_COINS = getEffectiveDailyCap(req.user, cfg.coin.maxDailyRewards, cfg.coin.unverifiedDailyCap);
    const remainingAllowance = MAX_DAILY_COINS - (gam.coinsEarnedToday || 0);
    const actualCoins = Math.round(Math.min(rewardDef.reward, remainingAllowance));
    gam.coinsBalance = Math.round(gam.coinsBalance + actualCoins);
    gam.coinsEarnedToday = Math.round((gam.coinsEarnedToday || 0) + actualCoins);

    // Run badge-specific side effects
    rewardDef.onClaim();

    if (!gam.claimHistory) gam.claimHistory = [];
    gam.claimHistory.push({
      rewardId,
      amount: actualCoins,
      source: rewardDef.title || `Claimed ${rewardId}`,
      createdAt: new Date(),
    });

    if (gam.claimHistory.length > 50) {
      gam.claimHistory.shift();
    }

    await gam.save();

    // Log coin transaction for reward claim
    const sourceMap = {
      steps_daily: 'DAILY_STEP_GOAL',
      hydration_daily: 'HYDRATION_GOAL',
    };
    const txSource = sourceMap[rewardId] || (rewardId.startsWith('streak_') ? 'STREAK_BADGE' : 'MANUAL');
    logCoinTransaction({
      userId,
      type: 'EARNED',
      amount: actualCoins,
      balanceAfter: gam.coinsBalance,
      source: txSource,
      description: rewardDef.title || `Claimed ${rewardId}`,
      metadata: {
        rewardId,
        date: today,
        badgeKey: rewardId.startsWith('streak_') ? rewardId.replace('streak_', '') : undefined,
      },
    });

    // ── Persist + push: reward claimed ───────────────────────────────────
    createNotification(userId, {
      type:    'COIN',
      title:   '🪙 Reward Claimed!',
      message: `You claimed ${actualCoins} coins for "${rewardDef.title}"!`,
      data:    { screen: 'Tracker' },
    });

    return success(res, `Claimed ${actualCoins} coins!`, {
      newBalance: gam.coinsBalance,
      rewardId,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Advanced Achievements ────────────────────────────────────────────────────
const Achievement = require('../models/Achievement.model');

const createAchievement = async (req, res, next) => {
  try {
    const { key, title, description, reward, criteriaType, targetValue, icon } = req.body;

    let achievement = await Achievement.findOne({ key });
    if (achievement) {
      achievement.title = title;
      achievement.description = description;
      achievement.reward = reward;
      achievement.criteriaType = criteriaType;
      achievement.targetValue = targetValue;
      if (icon) achievement.icon = icon;
      await achievement.save();
    } else {
      achievement = await Achievement.create({
        key, title, description, reward, criteriaType, targetValue, icon,
      });
    }

    return success(res, 'Achievement created/updated successfully', achievement);
  } catch (err) {
    next(err);
  }
};

const getAdvancedAchievements = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const achievements = await Achievement.find();

    const gam = await ensureGamDoc(userId);

    const activities = await HealthActivity.find({ user: userId });

    let totalSteps = 0;
    let maxDailySteps = 0;
    let totalWater = 0;
    activities.forEach(a => {
      totalSteps += a.steps;
      if (a.steps > maxDailySteps) maxDailySteps = a.steps;
      totalWater += a.hydration;
    });

    const ordersCount = await Order.countDocuments({ user: userId });

    const results = achievements.map(ach => {
      let progress = 0;
      switch (ach.criteriaType) {
        case 'STEPS_TOTAL': progress = totalSteps; break;
        case 'STEPS_DAILY': progress = maxDailySteps; break;
        case 'WATER_TOTAL': progress = totalWater; break;
        case 'ORDERS_COUNT': progress = ordersCount; break;
        default: progress = 0;
      }

      const isClaimed = gam.claimedAchievements?.some(
        c => c.achievementId.toString() === ach._id.toString()
      ) ?? false;

      const isClaimable = progress >= ach.targetValue && !isClaimed;

      return {
        _id: ach._id,
        id: ach._id,
        key: ach.key,
        title: ach.title,
        description: ach.description,
        reward: ach.reward,
        icon: ach.icon || 'Award',
        criteriaType: ach.criteriaType,
        targetValue: ach.targetValue,
        isActive: ach.isActive !== false,
        progress: Math.min(progress, ach.targetValue),
        isClaimable,
        isClaimed,
      };
    });

    return success(res, 'Advanced achievements fetched', results);
  } catch (err) {
    next(err);
  }
};

const claimAdvancedAchievement = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { achievementId } = req.body;

    if (!achievementId) return error(res, 'achievementId is required', 400);

    // ── Anti-cheat: block achievement claiming if user is penalized ──────────
    const coinBlockStatus = isCoinBlocked(req.user);
    if (coinBlockStatus.isBlocked) {
      return error(res, `Coin claims are blocked until ${coinBlockStatus.blockedUntil.toISOString().slice(0, 10)} due to suspicious step activity. ${coinBlockStatus.daysRemaining} days remaining.`, 403);
    }

    const achievement = await Achievement.findById(achievementId);
    if (!achievement) return error(res, 'Achievement not found', 404);

    const gam = await ensureGamDoc(userId);

    const alreadyClaimed = gam.claimedAchievements?.some(
      c => c.achievementId.toString() === achievement._id.toString()
    );
    if (alreadyClaimed) return error(res, 'Achievement already claimed', 400);

    let progress = 0;
    if (['STEPS_TOTAL', 'STEPS_DAILY', 'WATER_TOTAL'].includes(achievement.criteriaType)) {
      const activities = await HealthActivity.find({ user: userId });
      if (achievement.criteriaType === 'STEPS_TOTAL') {
        progress = activities.reduce((acc, curr) => acc + curr.steps, 0);
      } else if (achievement.criteriaType === 'STEPS_DAILY') {
        progress = Math.max(...activities.map(a => a.steps || 0), 0);
      } else if (achievement.criteriaType === 'WATER_TOTAL') {
        progress = activities.reduce((acc, curr) => acc + curr.hydration, 0);
      }
    } else if (achievement.criteriaType === 'ORDERS_COUNT') {
      progress = await Order.countDocuments({ user: userId });
    }

    if (progress < achievement.targetValue) {
      return error(res, 'Achievement criteria not met yet', 400);
    }

    gam.coinsBalance = Math.round(gam.coinsBalance + achievement.reward);

    if (!gam.claimHistory) gam.claimHistory = [];
    gam.claimHistory.push({
      rewardId: `ach_${achievement.key}`,
      amount: achievement.reward,
      source: `Achievement: ${achievement.title}`,
      createdAt: new Date(),
    });

    if (gam.claimHistory.length > 50) {
      gam.claimHistory.shift();
    }

    if (!gam.claimedAchievements) gam.claimedAchievements = [];
    gam.claimedAchievements.push({
      achievementId: achievement._id,
      claimedAt: new Date(),
    });

    await gam.save();

    // Log coin transaction for achievement
    logCoinTransaction({
      userId,
      type: 'EARNED',
      amount: achievement.reward,
      balanceAfter: gam.coinsBalance,
      source: 'ACHIEVEMENT',
      description: `Achievement: ${achievement.title}`,
      metadata: { achievementId: achievement._id, rewardId: `ach_${achievement.key}` },
    });

    // ── Persist + push: achievement claimed ──────────────────────────────
    createNotification(userId, {
      type:    'GOAL',
      title:   '🏆 Achievement Unlocked!',
      message: `You claimed "${achievement.title}" and earned ${achievement.reward} coins!`,
      data:    { screen: 'Achievements' },
    });

    return success(res, `Claimed ${achievement.reward} coins from achievement!`, {
      newBalance: gam.coinsBalance,
      achievementId: achievement._id,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Admin: Badge Definitions CRUD ───────────────────────────────────────────

// GET /gamification/admin/badges
const adminGetBadges = async (req, res, next) => {
  try {
    const badges = await BadgeDefinition.find().sort({ order: 1 });
    return success(res, 'Badge definitions fetched', badges);
  } catch (err) {
    next(err);
  }
};

// POST /gamification/admin/badges
const adminCreateBadge = async (req, res, next) => {
  try {
    const { key, title, rule, emoji, color, threshold, coinReward, order, isActive } = req.body;

    if (!key || !title || !rule || !emoji || !color || threshold == null || coinReward == null) {
      return error(res, 'Missing required badge fields', 400);
    }

    const existing = await BadgeDefinition.findOne({ key });
    if (existing) {
      return error(res, `Badge with key "${key}" already exists`, 409);
    }

    const badge = await BadgeDefinition.create({
      key, title, rule, emoji, color, threshold, coinReward,
      order: order ?? 0,
      isActive: isActive !== undefined ? isActive : true,
    });

    return success(res, 'Badge definition created', badge, 201);
  } catch (err) {
    next(err);
  }
};

// PUT /gamification/admin/badges/:id
const adminUpdateBadge = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Prevent key changes to avoid breaking existing user badge records
    delete updates.key;

    const badge = await BadgeDefinition.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!badge) return error(res, 'Badge definition not found', 404);

    return success(res, 'Badge definition updated', badge);
  } catch (err) {
    next(err);
  }
};

// DELETE /gamification/admin/badges/:id  (soft delete — sets isActive: false)
const adminDeleteBadge = async (req, res, next) => {
  try {
    const { id } = req.params;
    const badge = await BadgeDefinition.findByIdAndUpdate(
      id,
      { $set: { isActive: false } },
      { new: true }
    );

    if (!badge) return error(res, 'Badge definition not found', 404);

    return success(res, 'Badge definition deactivated', badge);
  } catch (err) {
    next(err);
  }
};

// ─── GET /gamification/coins/history ─────────────────────────────────────────
// Paginated coin history with optional category/type filtering.
// Query: ?page=1&limit=20&category=PASSIVE_STEPS&type=EARNED
const getCoinHistory = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const page     = Math.max(1, parseInt(req.query.page ?? '1', 10));
    const limit    = Math.min(50, parseInt(req.query.limit ?? '20', 10));
    const skip     = (page - 1) * limit;
    const category = req.query.category;
    const type     = req.query.type;

    const filter = { user: userId };
    if (category) filter.source = category;
    if (type) filter.type = type;

    const [transactions, total] = await Promise.all([
      CoinTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CoinTransaction.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    const formatted = transactions.map(t => ({
      id: t._id.toString(),
      type: t.type === 'REFUND' ? 'EARNED' : (t.type === 'DEDUCTED' ? 'SPENT' : t.type),
      amount: t.amount,
      source: t.description,
      createdAt: t.createdAt.toISOString(),
      balanceAfter: t.balanceAfter,
      category: t.source,
    }));

    return success(res, 'Coin history fetched', {
      transactions: formatted,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Admin: Update Achievement ────────────────────────────────────────────────
const adminUpdateAchievement = async (req, res, next) => {
  try {
    const ach = await Achievement.findById(req.params.id);
    if (!ach) return error(res, 'Achievement not found', 404);
    const fields = ['key', 'title', 'description', 'reward', 'criteriaType', 'targetValue', 'icon', 'isActive'];
    for (const f of fields) if (req.body[f] !== undefined) ach[f] = req.body[f];
    await ach.save();
    return success(res, 'Achievement updated', ach);
  } catch (err) {
    next(err);
  }
};

// ─── Admin: Delete Achievement ────────────────────────────────────────────────
const adminDeleteAchievement = async (req, res, next) => {
  try {
    const ach = await Achievement.findByIdAndDelete(req.params.id);
    if (!ach) return error(res, 'Achievement not found', 404);
    return success(res, 'Achievement deleted', { id: req.params.id });
  } catch (err) {
    next(err);
  }
};

// ─── Admin: Toggle Achievement Active/Inactive ───────────────────────────────
const adminToggleAchievement = async (req, res, next) => {
  try {
    const ach = await Achievement.findById(req.params.id);
    if (!ach) return error(res, 'Achievement not found', 404);
    ach.isActive = !ach.isActive;
    await ach.save();
    return success(res, `Achievement ${ach.isActive ? 'activated' : 'deactivated'}`, ach);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getGamification,
  getStreaks,
  syncGamification,
  earnCoins,
  getLeaderboard,
  getCoinData,
  getCoinHistory,
  claimReward,
  createAchievement,
  adminUpdateAchievement,
  adminDeleteAchievement,
  adminToggleAchievement,
  getAdvancedAchievements,
  claimAdvancedAchievement,
  adminGetBadges,
  adminCreateBadge,
  adminUpdateBadge,
  adminDeleteBadge,
};
