// src/controllers/gamification.controller.js
const Gamification = require('../models/Gamification.model');
const BadgeDefinition = require('../models/BadgeDefinition.model');
const HealthActivity = require('../models/HealthActivity.model');
const Order = require('../models/Order.model');
const { success, error } = require('../utils/response');
const { todayISO } = require('../utils/date');

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

    return success(res, 'Gamification data fetched', {
      coinsBalance: gam.coinsBalance,
      streakDays: gam.streakDays,
      bestStreakDays: gam.bestStreakDays,
      lastActiveDate: gam.lastActiveDate,
      coinsEarnedToday: gam.coinsEarnedToday,
      lastCoinDate: gam.lastCoinDate,
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

    if (streakDays !== undefined) gam.streakDays = streakDays;
    if (bestStreakDays !== undefined && bestStreakDays > gam.bestStreakDays) {
      gam.bestStreakDays = bestStreakDays;
    }
    if (lastActiveDate !== undefined) gam.lastActiveDate = lastActiveDate;
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
const earnCoins = async (req, res, next) => {
  try {
    const { coinsToAdd, goalMet } = req.body;

    if (!coinsToAdd || coinsToAdd <= 0) {
      return error(res, 'coinsToAdd must be positive', 400);
    }

    const today = todayISO();
    const gam = await ensureGamDoc(req.user._id);

    // Reset daily coins if it's a new day
    if (gam.lastCoinDate !== today) {
      gam.coinsEarnedToday = 0;
    }

    const MAX_DAILY_COINS = 250;
    const remainingAllowance = MAX_DAILY_COINS - (gam.coinsEarnedToday || 0);
    const actualCoins = Math.round(Math.min(coinsToAdd, remainingAllowance));

    if (actualCoins > 0) {
      gam.coinsBalance = Math.round(gam.coinsBalance + actualCoins);
      gam.coinsEarnedToday = Math.round((gam.coinsEarnedToday || 0) + actualCoins);
      gam.lastCoinDate = today;

      if (!gam.claimHistory) gam.claimHistory = [];
      gam.claimHistory.push({
        rewardId: 'steps_daily_card',
        amount: actualCoins,
        source: 'Daily Step Reward',
        createdAt: new Date(),
      });

      if (gam.claimHistory.length > 50) {
        gam.claimHistory.shift();
      }
    }

    await gam.save();

    return success(res, `Earned ${actualCoins} coins`, {
      coinsBalance: gam.coinsBalance,
      coinsEarnedToday: gam.coinsEarnedToday,
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

    const data = top.map((g, i) => ({
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

    const [gam, badgeDefs] = await Promise.all([
      ensureGamDoc(userId),
      loadBadgeDefs(),
    ]);

    gam.migrateOldBadges();

    // ── Build transaction history ─────────────────────────────────────────────
    const recentOrders = await Order.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('totalCoins totalPrice createdAt _id paymentMethod');

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyAgoISO = thirtyDaysAgo.toISOString().split('T')[0];

    const activities = await HealthActivity.find({
      user: userId,
      goalMet: true,
      date: { $gte: thirtyAgoISO },
    })
      .sort({ date: -1 })
      .limit(20)
      .select('date steps calories goalMet coinsEarned');

    const transactions = [
      ...activities.map(a => ({
        id: `act_${a._id}`,
        type: 'EARNED',
        amount: a.coinsEarned || 10,
        source: `Passive Step Coins — ${a.steps.toLocaleString()} steps`,
        createdAt: new Date(a.date).toISOString(),
      })),
      ...recentOrders
        .filter(o => o.totalCoins > 0 && o.paymentMethod === 'COIN_PURCHASE')
        .map(o => ({
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

    // ── Build claimable rewards ───────────────────────────────────────────────
    const todayActivity = await HealthActivity.findOne({ user: userId, date: today });
    const todaySteps = todayActivity?.steps ?? 0;
    const todayWater = todayActivity?.hydration ?? 0;
    const streakDays = gam.streakDays ?? 0;
    const dailyGoal = req.user.dailyStepGoal || 10000;

    // Dynamic streak badge rewards from DB
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
        reward: 50,
        currentValue: todaySteps,
        isClaimed: todaySteps >= dailyGoal && gam.lastCoinDate === today,
      },
      {
        id: 'hydration_daily',
        title: 'Daily Water Goal (2000ml)',
        threshold: 2000,
        reward: 20,
        currentValue: todayWater,
        isClaimed: gam.lastWaterCoinDate === today,
      },
      ...streakClaimable,
    ];

    await gam.save();

    return success(res, 'Coin data fetched', {
      balance: gam.coinsBalance,
      transactions,
      claimable,
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

    const [gam, badgeDefs] = await Promise.all([
      ensureGamDoc(userId),
      loadBadgeDefs(),
    ]);

    gam.migrateOldBadges();

    const todayActivity = await HealthActivity.findOne({ user: userId, date: today });
    const todaySteps = todayActivity?.steps ?? 0;
    const todayWater = todayActivity?.hydration ?? 0;
    const dailyGoal = req.user.dailyStepGoal || 10000;

    // Build dynamic reward map: static + streak-per-badge-def
    const REWARDS = {
      steps_daily: {
        title: `Walk ${dailyGoal.toLocaleString()} Steps`,
        reward: 50,
        isMet: () => todaySteps >= dailyGoal,
        isAlreadyClaimed: () => gam.lastCoinDate === today,
        onClaim: () => { gam.lastCoinDate = today; },
      },
      hydration_daily: {
        title: 'Daily Water Goal Completed',
        reward: 20,
        isMet: () => todayWater >= 2000,
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

    gam.coinsBalance = Math.round(gam.coinsBalance + rewardDef.reward);
    gam.coinsEarnedToday = Math.round((gam.coinsEarnedToday || 0) + rewardDef.reward);

    // Run badge-specific side effects
    rewardDef.onClaim();

    if (!gam.claimHistory) gam.claimHistory = [];
    gam.claimHistory.push({
      rewardId,
      amount: rewardDef.reward,
      source: rewardDef.title || `Claimed ${rewardId}`,
      createdAt: new Date(),
    });

    if (gam.claimHistory.length > 50) {
      gam.claimHistory.shift();
    }

    await gam.save();

    return success(res, `Claimed ${rewardDef.reward} coins!`, {
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
        id: ach._id,
        key: ach.key,
        title: ach.title,
        description: ach.description,
        reward: ach.reward,
        icon: ach.icon || 'Award',
        criteriaType: ach.criteriaType,
        targetValue: ach.targetValue,
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

module.exports = {
  getGamification,
  getStreaks,
  syncGamification,
  earnCoins,
  getLeaderboard,
  getCoinData,
  claimReward,
  createAchievement,
  getAdvancedAchievements,
  claimAdvancedAchievement,
  adminGetBadges,
  adminCreateBadge,
  adminUpdateBadge,
  adminDeleteBadge,
};
