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

    // Only update coins if syncing today's data (prevent backdating abuse)
    if (coinsBalance !== undefined) gam.coinsBalance = coinsBalance;
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
    const actualCoins = Math.min(coinsToAdd, remainingAllowance);

    if (actualCoins > 0) {
      gam.coinsBalance += actualCoins;
      gam.coinsEarnedToday = (gam.coinsEarnedToday || 0) + actualCoins;
      gam.lastCoinDate = today;
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
      // Earned from step goals
      ...activities.map(a => ({
        id: `act_${a._id}`,
        type: 'EARNED',
        amount: a.coinsEarned || 10, // fallback 10 if field missing
        source: `Step Goal Achieved — ${a.steps.toLocaleString()} steps`,
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
        isClaimed: todayWater >= 2000,
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
        reward: 500,
        currentValue: streakDays,
        isClaimed: gam.badges?.finisher?.unlocked ?? false,
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
        reward: 50,
        isMet: () => todaySteps >= dailyGoal,
        isAlreadyClaimed: () => gam.lastCoinDate === today,
      },
      hydration_daily: {
        reward: 20,
        isMet: () => todayWater >= 2000,
        isAlreadyClaimed: () => false, // no persistent flag for hydration yet
      },
      streak_weekly: {
        reward: 200,
        isMet: () => gam.streakDays >= 7,
        isAlreadyClaimed: () => gam.badges?.consistent?.unlocked ?? false,
      },
      streak_biweekly: {
        reward: 500,
        isMet: () => gam.streakDays >= 15,
        isAlreadyClaimed: () => gam.badges?.finisher?.unlocked ?? false,
      },
    };

    const rewardDef = REWARDS[rewardId];
    if (!rewardDef) return error(res, 'Unknown reward ID', 400);
    if (!rewardDef.isMet()) return error(res, 'Reward threshold not yet reached', 400);
    if (rewardDef.isAlreadyClaimed()) return error(res, 'Reward already claimed', 400);

    gam.coinsBalance += rewardDef.reward;
    gam.coinsEarnedToday = (gam.coinsEarnedToday || 0) + rewardDef.reward;
    gam.lastCoinDate = today;

    // For streak rewards, award badge too
    if (rewardId === 'streak_weekly' && !gam.badges.consistent.unlocked) {
      gam.badges.consistent.unlocked = true;
      gam.badges.consistent.unlockedAt = new Date();
    }
    if (rewardId === 'streak_biweekly' && !gam.badges.finisher.unlocked) {
      gam.badges.finisher.unlocked = true;
      gam.badges.finisher.unlockedAt = new Date();
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

module.exports = {
  getGamification,
  getStreaks,
  syncGamification,
  earnCoins,
  getLeaderboard,
  getCoinData,
  claimReward,
};
