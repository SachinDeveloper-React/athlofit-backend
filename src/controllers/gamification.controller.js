// src/controllers/gamification.controller.js
const Gamification = require('../models/Gamification.model');
const HealthActivity = require('../models/HealthActivity.model');
const Order = require('../models/Order.model');
const { success, error } = require('../utils/response');
const { todayISO, buildDateRange } = require('../utils/date');

// ─── GET /gamification/me ─────────────────────────────────────────────────────
// Returns: GamificationState (coinsBalance, streakDays, etc.)
const getGamification = async (req, res, next) => {
  try {
    let gam = await Gamification.findOne({ user: req.user._id });

    if (!gam) {
      gam = await Gamification.create({ user: req.user._id });
    }

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
// Returns: StreaksResponseData (streakDays, bestStreakDays, nextBadgeAt, badges[])
const getStreaks = async (req, res, next) => {
  try {
    let gam = await Gamification.findOne({ user: req.user._id });

    if (!gam) {
      gam = await Gamification.create({ user: req.user._id });
    }

    const data = {
      streakDays: gam.streakDays,
      bestStreakDays: gam.bestStreakDays,
      nextBadgeAt: gam.getNextBadgeAt(),
      badges: gam.getBadgeList(),
    };

    return success(res, 'Streaks fetched', data);
  } catch (err) {
    next(err);
  }
};

// ─── POST /gamification/sync ──────────────────────────────────────────────────
// Body: { coinsEarnedToday, streakDays, ... }  — syncs local state to server
const syncGamification = async (req, res, next) => {
  try {
    const {
      coinsBalance,
      coinsEarnedToday,
      streakDays,
      bestStreakDays,
      lastActiveDate,
      lastCoinDate,
    } = req.body;

    const today = todayISO();

    let gam = await Gamification.findOne({ user: req.user._id });
    if (!gam) {
      gam = await Gamification.create({ user: req.user._id });
    }

    // IMPORTANT: NEVER accept `coinsBalance` from client sync!
    // Coins should only be mutated via explicit earn/spend endpoints.
    // if (coinsBalance !== undefined) gam.coinsBalance = coinsBalance; // REMOVED
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
    gam.awardBadges();

    await gam.save();

    return success(res, 'Gamification synced');
  } catch (err) {
    next(err);
  }
};

// ─── POST /gamification/coins/earn ───────────────────────────────────────────
// Earn coins for completing a goal (called by app when step goal met)
const earnCoins = async (req, res, next) => {
  try {
    const { coinsToAdd, goalMet } = req.body;

    if (!coinsToAdd || coinsToAdd <= 0) {
      return error(res, 'coinsToAdd must be positive', 400);
    }

    const today = todayISO();
    let gam = await Gamification.findOne({ user: req.user._id });
    if (!gam) {
      gam = await Gamification.create({ user: req.user._id });
    }

    // Reset daily coins if it's a new day
    if (gam.lastCoinDate !== today) {
      gam.coinsEarnedToday = 0;
    }

    // Cap daily earning to prevent abuse (250 coins max per day from app)
    const MAX_DAILY_COINS = 250;
    const remainingAllowance = MAX_DAILY_COINS - (gam.coinsEarnedToday || 0);
    // Big Company Rule: Prevent floating point currency issues by using Math.round
    const actualCoins = Math.round(Math.min(coinsToAdd, remainingAllowance));

    if (actualCoins > 0) {
      // Ensure we are working with integers
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
    const top = await Gamification.find()
      .sort({ coinsBalance: -1 })
      .limit(20)
      .populate('user', 'name avatarUrl');

    const data = top.map((g, i) => ({
      rank: i + 1,
      userId: g.user._id,
      name: g.user.name,
      avatarUrl: g.user.avatarUrl,
      coinsBalance: g.coinsBalance,
      streakDays: g.streakDays,
      badgesCount: g.getBadgeList().filter(b => b.unlocked).length,
    }));

    return success(res, 'Leaderboard fetched', data);
  } catch (err) {
    next(err);
  }
};

// ─── GET /gamification/coins/data ────────────────────────────────────────────
// Returns: CoinData { balance, transactions[], claimable[] }
// transactions = last 30 coin events derived from Gamification + Orders
// claimable   = dynamic rewards based on today's HealthActivity progress
const getCoinData = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const today = todayISO();

    let gam = await Gamification.findOne({ user: userId });
    if (!gam) gam = await Gamification.create({ user: userId });

    // ── Build transaction history ─────────────────────────────────────────────
    // Recent orders as SPENT transactions
    const recentOrders = await Order.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('totalCoins totalPrice createdAt _id paymentMethod');


    // Last 30 days of health activity where goal was met = EARNED
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
      // Earned from passive step generation
      ...activities.map(a => ({
        id: `act_${a._id}`,
        type: 'EARNED',
        amount: a.coinsEarned || 10,
        source: `Passive Step Coins — ${a.steps.toLocaleString()} steps`,
        createdAt: new Date(a.date).toISOString(),
      })),
      // Spent on orders (only coin purchases)
      ...recentOrders
        .filter(o => o.totalCoins > 0 && o.paymentMethod === 'COIN_PURCHASE')
        .map(o => ({
          id: `ord_${o._id}`,
          type: 'SPENT',
          amount: o.totalCoins,
          source: `Shop Purchase — Order #${o._id.toString().slice(-6).toUpperCase()}`,
          createdAt: o.createdAt.toISOString(),
        })),
        // Hydration and Streak Claims
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
    const todaySteps     = todayActivity?.steps ?? 0;
    const todayWater     = todayActivity?.hydration ?? 0;
    const streakDays     = gam.streakDays ?? 0;
    const dailyGoal      = req.user.dailyStepGoal || 10000;

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
      {
        id: 'streak_weekly',
        title: 'Complete 7-Day Streak',
        threshold: 7,
        reward: 200,
        currentValue: streakDays,
        isClaimed: gam.badges?.consistent?.unlocked ?? false,
      },
      {
        id: 'streak_biweekly',
        title: 'Complete 15-Day Streak',
        threshold: 15,
        reward: 400,
        currentValue: streakDays,
        isClaimed: gam.badges?.finisher?.unlocked ?? false,
      },
      {
        id: 'streak_monthly',
        title: 'Complete 30-Day Streak',
        threshold: 30,
        reward: 800,
        currentValue: streakDays,
        isClaimed: gam.badges?.elite?.unlocked ?? false,
      },
    ];

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
// Body: { rewardId }  — awards coins if reward threshold is met and not yet claimed
const claimReward = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { rewardId } = req.body;
    const today = todayISO();

    if (!rewardId) return error(res, 'rewardId is required', 400);

    let gam = await Gamification.findOne({ user: userId });
    if (!gam) gam = await Gamification.create({ user: userId });

    const todayActivity = await HealthActivity.findOne({ user: userId, date: today });
    const todaySteps = todayActivity?.steps ?? 0;
    const todayWater = todayActivity?.hydration ?? 0;
    const dailyGoal  = req.user.dailyStepGoal || 10000;

    const REWARDS = {
      steps_daily: {
        title: `Walk ${dailyGoal.toLocaleString()} Steps`,
        reward: 50,
        isMet: () => todaySteps >= dailyGoal,
        isAlreadyClaimed: () => gam.lastCoinDate === today,
      },
      hydration_daily: {
        title: 'Daily Water Goal Completed',
        reward: 20,
        isMet: () => todayWater >= 2000,
        isAlreadyClaimed: () => gam.lastWaterCoinDate === today,
      },
      streak_weekly: {
        title: '7-Day Streak Complete',
        reward: 200,
        isMet: () => gam.streakDays >= 7,
        isAlreadyClaimed: () => gam.badges?.consistent?.unlocked ?? false,
      },
      streak_biweekly: {
        title: '15-Day Streak Complete',
        reward: 400,
        isMet: () => gam.streakDays >= 15,
        isAlreadyClaimed: () => gam.badges?.finisher?.unlocked ?? false,
      },
      streak_monthly: {
        title: '30-Day Streak Complete',
        reward: 800,
        isMet: () => gam.streakDays >= 30,
        isAlreadyClaimed: () => gam.badges?.elite?.unlocked ?? false,
      },
    };

    const rewardDef = REWARDS[rewardId];
    if (!rewardDef) return error(res, 'Unknown reward ID', 400);
    if (!rewardDef.isMet()) return error(res, 'Reward threshold not yet reached', 400);
    if (rewardDef.isAlreadyClaimed()) return error(res, 'Reward already claimed', 400);

    gam.coinsBalance = Math.round(gam.coinsBalance + rewardDef.reward);
    gam.coinsEarnedToday = Math.round((gam.coinsEarnedToday || 0) + rewardDef.reward);
    gam.lastCoinDate = today;

    // For streak/hydration rewards, award badge and set constraints
    if (rewardId === 'hydration_daily') {
      gam.lastWaterCoinDate = today;
    }
    if (rewardId === 'streak_weekly' && !gam.badges.consistent.unlocked) {
      gam.badges.consistent.unlocked = true;
      gam.badges.consistent.unlockedAt = new Date();
    }
    if (rewardId === 'streak_biweekly' && !gam.badges.finisher.unlocked) {
      gam.badges.finisher.unlocked = true;
      gam.badges.finisher.unlockedAt = new Date();
    }
    if (rewardId === 'streak_monthly' && !gam.badges.elite.unlocked) {
      gam.badges.elite.unlocked = true;
      gam.badges.elite.unlockedAt = new Date();
    }

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

// ─── POST /gamification/achievements (Admin/Internal) ────────────────────────
// Body: { key, title, description, reward, criteriaType, targetValue, icon }
const Achievement = require('../models/Achievement.model');

const createAchievement = async (req, res, next) => {
  try {
    const { key, title, description, reward, criteriaType, targetValue, icon } = req.body;
    
    let achievement = await Achievement.findOne({ key });
    if (achievement) {
      // Update existing
      achievement.title = title;
      achievement.description = description;
      achievement.reward = reward;
      achievement.criteriaType = criteriaType;
      achievement.targetValue = targetValue;
      if (icon) achievement.icon = icon;
      await achievement.save();
    } else {
      achievement = await Achievement.create({
        key, title, description, reward, criteriaType, targetValue, icon
      });
    }

    return success(res, 'Achievement created/updated successfully', achievement);
  } catch (err) {
    next(err);
  }
};

// ─── GET /gamification/achievements ──────────────────────────────────────────
// Returns a list of all advanced achievements and the user's progress for each.
const getAdvancedAchievements = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const achievements = await Achievement.find();
    
    let gam = await Gamification.findOne({ user: userId });
    if (!gam) gam = await Gamification.create({ user: userId });

    // Pre-compute basic metrics for criteria checking
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
        case 'STEPS_TOTAL':
          progress = totalSteps;
          break;
        case 'STEPS_DAILY':
          progress = maxDailySteps;
          break;
        case 'WATER_TOTAL':
          progress = totalWater;
          break;
        case 'ORDERS_COUNT':
          progress = ordersCount;
          break;
        default:
          progress = 0;
      }

      // Check if previously claimed
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

// ─── POST /gamification/achievements/claim ─────────────────────────────────────
// Body: { achievementId }
const claimAdvancedAchievement = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { achievementId } = req.body;

    if (!achievementId) return error(res, 'achievementId is required', 400);

    const achievement = await Achievement.findById(achievementId);
    if (!achievement) return error(res, 'Achievement not found', 404);

    let gam = await Gamification.findOne({ user: userId });
    if (!gam) gam = await Gamification.create({ user: userId });

    // Check if already claimed
    const alreadyClaimed = gam.claimedAchievements?.some(
      c => c.achievementId.toString() === achievement._id.toString()
    );
    if (alreadyClaimed) return error(res, 'Achievement already claimed', 400);

    // Re-verify progress
    let progress = 0;
    if (achievement.criteriaType === 'STEPS_TOTAL' || achievement.criteriaType === 'STEPS_DAILY' || achievement.criteriaType === 'WATER_TOTAL') {
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

    // Award
    gam.coinsBalance = Math.round(gam.coinsBalance + achievement.reward);
    const today = new Date().toISOString().split('T')[0];
    
    // We do NOT add advanced achievements to the daily limit since they are one-time massive rewards
    
    // Log transaction
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

    // Mark as claimed
    if (!gam.claimedAchievements) gam.claimedAchievements = [];
    gam.claimedAchievements.push({
      achievementId: achievement._id,
      claimedAt: new Date(),
    });

    await gam.save();

    return success(res, `Claimed \${achievement.reward} coins from achievement!`, {
      newBalance: gam.coinsBalance,
      achievementId: achievement._id,
    });
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
};
