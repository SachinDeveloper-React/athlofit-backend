// src/controllers/streakRestore.controller.js
// ─── POST /gamification/streak/restore ───────────────────────────────────────
// Allows a user to pay coins to restore their broken streak.

const Gamification = require('../models/Gamification.model');
const { success, error } = require('../utils/response');
const { getStreakConfig, restoreStreak } = require('../utils/streak');
const { logCoinTransaction } = require('../utils/logCoinTransaction');
const { createNotification } = require('../utils/createNotification');

module.exports = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const gam = await Gamification.findOne({ user: userId });
    if (!gam) return error(res, 'Gamification profile not found', 404);

    const cfg = await getStreakConfig();
    const result = restoreStreak(gam, cfg);

    if (!result.success) {
      return error(res, result.message, 400);
    }

    await gam.save();

    // Log the coin spend.
    logCoinTransaction({
      userId,
      type: 'SPENT',
      amount: result.cost,
      balanceAfter: gam.coinsBalance,
      source: 'MANUAL',
      description: `Streak restored (${result.restoredTo} days) for ${result.cost} coins`,
      metadata: { rewardId: 'streak_restore' },
    });

    createNotification(userId, {
      type: 'STREAK',
      title: '🔥 Streak Restored!',
      message: `Your ${result.restoredTo}-day streak is back! Keep it going.`,
      data: { screen: 'Tracker' },
    });

    return success(res, 'Streak restored!', {
      streakDays: gam.streakDays,
      coinsBalance: gam.coinsBalance,
      cost: result.cost,
    });
  } catch (err) {
    next(err);
  }
};
