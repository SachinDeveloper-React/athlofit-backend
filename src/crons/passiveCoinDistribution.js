// src/crons/passiveCoinDistribution.js
// ─── Automatic passive coin distribution based on step increments ─────────────
//
// Runs every 3 hours (00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00, 21:00)
// and once at 23:59 (EOD) to award remaining coins.
//
// This cron acts as a SAFETY NET for users whose app hasn't synced recently.
// The primary coin-awarding + logging now happens in the health sync endpoint
// (every sync logs a transaction). The cron skips users who synced within 5 min.
//
// Logic:
//   1. For each user with HealthActivity today, calculate current steps.
//   2. Skip if health sync already handled this user recently (within 5 min).
//   3. Compare against lastPassiveCoinSteps (steps at last payout).
//   4. Compute coins = Math.floor(stepDelta / 100) * rate_per_100_steps.
//   5. Cap at remaining daily allowance (dailyEarnLimit - coinsEarnedToday).
//   6. Award coins, log transaction, update markers.

const cron = require('node-cron');
const Gamification = require('../models/Gamification.model');
const HealthActivity = require('../models/HealthActivity.model');
const AppConfig = require('../models/AppConfig.model');
const User = require('../models/User.model');
const { todayISO } = require('../utils/date');
const { logCoinTransaction } = require('../utils/logCoinTransaction');
const { isCoinBlocked } = require('../utils/cheatPenalty');

// ─── Core distribution function ──────────────────────────────────────────────

async function distributePassiveCoins() {
  const today = todayISO();
  const now = new Date();

  // Load config
  let cfg = await AppConfig.findOne({ key: 'global' });
  if (!cfg) cfg = await AppConfig.create({ key: 'global' });

  const rate = cfg.coin_config?.steps?.rate_per_100_steps ?? 0.5;
  const dailyEarnLimit = cfg.coin?.dailyEarnLimit ?? 10;
  const unverifiedDailyCap = cfg.coin?.unverifiedDailyCap ?? 50;

  // Find all users who have health activity today (meaning they synced steps)
  const activities = await HealthActivity.find({ date: today, steps: { $gt: 0 } })
    .select('user steps')
    .lean();

  if (activities.length === 0) {
    console.log(`[CRON:PassiveCoins] No activities for ${today}. Skipping.`);
    return { processed: 0, awarded: 0, totalCoins: 0 };
  }

  // Batch-load user verification status
  const userIds = activities.map(a => a.user);
  const users = await User.find({ _id: { $in: userIds } })
    .select('_id emailVerified')
    .lean();
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  let processed = 0;
  let awarded = 0;
  let totalCoinsAwarded = 0;

  for (const activity of activities) {
    const userId = activity.user;
    const currentSteps = activity.steps;

    try {
      // Get or create gamification record
      let gam = await Gamification.findOne({ user: userId });
      if (!gam) {
        gam = await Gamification.create({ user: userId });
      }

      processed++;

      // ── Anti-cheat: skip if user is blocked from earning coins ─────────────
      const userDoc = await User.findById(userId).select('coinBlockedUntil').lean();
      if (userDoc && isCoinBlocked(userDoc).isBlocked) continue;

      // Reset coinsEarnedToday if it's a new day
      const lastCoinDate = gam.lastCoinDate;
      if (lastCoinDate && lastCoinDate !== today) {
        gam.coinsEarnedToday = 0;
        gam.lastPassiveCoinSteps = 0;
        gam.lastPassiveCoinTime = null;
      }

      // Calculate step delta since last payout
      const previousSteps = gam.lastPassiveCoinSteps || 0;
      const stepDelta = currentSteps - previousSteps;

      // Skip if no new steps since last payout
      if (stepDelta <= 0) continue;

      // Skip if a health sync recently processed and logged coins (within 5 min).
      // Since the health sync now logs every transaction (no throttle), the cron
      // only needs to act as a safety net for users whose app hasn't synced recently.
      if (gam.lastPassiveCoinTime) {
        const timeSinceLastAward = Date.now() - new Date(gam.lastPassiveCoinTime).getTime();
        if (timeSinceLastAward < 5 * 60 * 1000) continue; // skip, sync just handled it
      }

      // Determine the user's effective passive daily cap
      const user = userMap.get(userId.toString());
      const isVerified = user?.emailVerified ?? false;
      const effectiveCap = isVerified
        ? dailyEarnLimit
        : Math.min(unverifiedDailyCap, dailyEarnLimit);

      // Calculate coins using the same formula as health sync:
      // Total passive coins earned today = min(dailyEarnLimit, floor(totalSteps/100) * rate)
      // Only award the difference between what should be earned and what's already in coinsEarnedToday.
      const totalPassiveCoinsForToday = parseFloat(
        Math.min(effectiveCap, Math.max(0, Math.floor(currentSteps / 100) * rate)).toFixed(4)
      );

      const currentEarned = gam.coinsEarnedToday || 0;
      // coinsEarnedToday may include goal/hydration coins, so use lastPassiveCoinSteps as base
      const passiveAlreadyAwarded = parseFloat(
        Math.min(effectiveCap, Math.max(0, Math.floor(previousSteps / 100) * rate)).toFixed(4)
      );
      const actualCoins = parseFloat(
        Math.max(0, totalPassiveCoinsForToday - passiveAlreadyAwarded).toFixed(4)
      );

      // Also check we don't exceed the overall daily cap
      const overallCap = cfg.coin?.maxDailyRewards ?? 250;
      const overallRemaining = Math.max(0, overallCap - currentEarned);
      const finalCoins = parseFloat(Math.min(actualCoins, overallRemaining).toFixed(4));

      if (finalCoins <= 0) continue;

      // Award coins
      gam.coinsBalance = parseFloat((gam.coinsBalance + finalCoins).toFixed(4));
      gam.coinsEarnedToday = parseFloat(((gam.coinsEarnedToday || 0) + finalCoins).toFixed(4));
      gam.lastCoinDate = today;
      gam.lastPassiveCoinSteps = currentSteps;
      gam.lastPassiveCoinTime = now;
      await gam.save();

      // Log transaction
      logCoinTransaction({
        userId,
        type: 'EARNED',
        amount: finalCoins,
        balanceAfter: gam.coinsBalance,
        source: 'PASSIVE_STEPS',
        description: `Auto Step Coins — ${previousSteps.toLocaleString()} → ${currentSteps.toLocaleString()} (+${stepDelta.toLocaleString()} steps)`,
        metadata: {
          steps: currentSteps,
          previousSteps,
          stepDelta,
          date: today,
          trigger: 'cron',
        },
      });

      awarded++;
      totalCoinsAwarded += finalCoins;
    } catch (err) {
      console.error(`[CRON:PassiveCoins] Error processing user ${userId}:`, err.message);
    }
  }

  console.log(
    `[CRON:PassiveCoins] Done — ${processed} users checked, ${awarded} awarded, ${totalCoinsAwarded.toFixed(4)} total coins distributed`
  );

  return { processed, awarded, totalCoins: totalCoinsAwarded };
}

// ─── Schedule the cron jobs ──────────────────────────────────────────────────

function startPassiveCoinCron() {
  // Every 3 hours: 00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00, 21:00 IST
  cron.schedule('0 0,3,6,9,12,15,18,21 * * *', () => {
    console.log('[CRON:PassiveCoins] Running 3-hour distribution...');
    distributePassiveCoins().catch(err =>
      console.error('[CRON:PassiveCoins] 3-hour job failed:', err.message)
    );
  }, { timezone: 'Asia/Kolkata' });

  // EOD at 23:59:50 IST — final sweep to award any remaining step coins
  cron.schedule('50 59 23 * * *', () => {
    console.log('[CRON:PassiveCoins] Running EOD final distribution...');
    distributePassiveCoins().catch(err =>
      console.error('[CRON:PassiveCoins] EOD job failed:', err.message)
    );
  }, { timezone: 'Asia/Kolkata' });

  console.log('⏰ Passive coin cron scheduled (IST): every 3h (0,3,6,9,12,15,18,21) + EOD @23:59:50');
}

module.exports = { startPassiveCoinCron, distributePassiveCoins };
