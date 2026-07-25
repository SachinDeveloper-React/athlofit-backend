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
//   4. Compute passive coins = min(dailyEarnLimit, floor(steps/100) * rate),
//      awarding only the difference vs. what the watermark already earned.
//      The passive cap is STEP-DERIVED — independent of goal/hydration coins.
//   5. Also clamp to the overall daily cap (maxDailyRewards, all sources).
//   6. Award coins atomically, log transaction, update markers.

const cron = require('node-cron');
const Gamification = require('../models/Gamification.model');
const HealthActivity = require('../models/HealthActivity.model');
const AppConfig = require('../models/AppConfig.model');
const User = require('../models/User.model');
const { todayISO } = require('../utils/date');
const { logCoinTransaction } = require('../utils/logCoinTransaction');
const { isCoinBlocked } = require('../utils/cheatPenalty');
const { computePassiveCoinDelta } = require('../utils/passiveCoins');

// ─── Core distribution function ──────────────────────────────────────────────

async function distributePassiveCoins() {
  const today = todayISO();
  const now = new Date();

  // Load config
  let cfg = await AppConfig.findOne({ key: 'global' });
  if (!cfg) cfg = await AppConfig.create({ key: 'global' });

  const rate = cfg.coin_config?.steps?.rate_per_100_steps ?? 0.5;
  const dailyEarnLimit = cfg.coin?.dailyEarnLimit ?? 200;
  const unverifiedDailyCap = cfg.coin?.unverifiedDailyCap ?? 50;

  // Find all users who have health activity today (meaning they synced steps)
  const activities = await HealthActivity.find({ date: today, steps: { $gt: 0 } })
    .select('user steps')
    .lean();

  if (activities.length === 0) {
    console.log(`[CRON:PassiveCoins] No activities for ${today}. Skipping.`);
    return { processed: 0, awarded: 0, totalCoins: 0 };
  }

  // Batch-load user verification + cheat-block status in one query
  const userIds = activities.map(a => a.user);
  const users = await User.find({ _id: { $in: userIds } })
    .select('_id emailVerified coinBlockedUntil')
    .lean();
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  let processed = 0;
  let awarded = 0;
  let totalCoinsAwarded = 0;
  const skipReasons = { blocked: 0, noNewSteps: 0, recentSync: 0, capReached: 0, raceLost: 0 };
  const debug = process.env.CRON_DEBUG === 'true';

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
      const userDoc = userMap.get(userId.toString());
      if (userDoc && isCoinBlocked(userDoc).isBlocked) { skipReasons.blocked++; continue; }

      // Reset coinsEarnedToday if it's a new day (read-only check — the atomic
      // update below handles the actual state transition safely)
      const lastCoinDate = gam.lastCoinDate;
      const isNewDay = !lastCoinDate || lastCoinDate !== today;
      
      // Use the correct baseline: if new day, watermark resets to 0
      const previousSteps = isNewDay ? 0 : (gam.lastPassiveCoinSteps || 0);
      const stepDelta = currentSteps - previousSteps;

      if (debug) {
        console.log(`[CRON:PassiveCoins] user=${userId} steps=${currentSteps} watermark=${previousSteps} delta=${stepDelta} earnedToday=${gam.coinsEarnedToday} lastCoinDate=${lastCoinDate} lastPassiveTime=${gam.lastPassiveCoinTime}`);
      }

      // Skip if no new steps since last payout
      if (stepDelta <= 0) { skipReasons.noNewSteps++; continue; }

      // Skip if a health sync recently processed and logged coins (within 5 min).
      if (gam.lastPassiveCoinTime) {
        const timeSinceLastAward = Date.now() - new Date(gam.lastPassiveCoinTime).getTime();
        if (timeSinceLastAward < 5 * 60 * 1000) { skipReasons.recentSync++; continue; }
      }

      // Determine the user's effective passive daily cap
      const isVerified = userDoc?.emailVerified ?? false;
      const effectiveCap = isVerified
        ? dailyEarnLimit
        : Math.min(unverifiedDailyCap, dailyEarnLimit);

      // Step-derived passive coins — identical math to the health sync path
      // (shared helper). Cap is independent of goal/hydration coins.
      const { coins: actualCoins } = computePassiveCoinDelta({
        currentSteps,
        watermark: previousSteps,
        rate,
        dailyEarnLimit: effectiveCap,
      });

      // Also check we don't exceed the overall daily cap (all coin sources)
      const currentEarned = isNewDay ? 0 : (gam.coinsEarnedToday || 0);
      const overallCap = cfg.coin?.maxDailyRewards ?? 250;
      const overallRemaining = Math.max(0, overallCap - currentEarned);
      const finalCoins = parseFloat(Math.min(actualCoins, overallRemaining).toFixed(4));

      if (finalCoins <= 0) { skipReasons.capReached++; continue; }

      // Award coins ATOMICALLY — prevents race with concurrent health syncs.
      // Only updates if lastPassiveCoinSteps hasn't moved past our baseline.
      //
      // If it's a new day, reset coinsEarnedToday to finalCoins instead of
      // incrementing a stale yesterday value. Use $set for the new-day case,
      // $inc for same-day case.
      const updateOp = isNewDay
        ? {
            $set: {
              lastCoinDate: today,
              lastPassiveCoinSteps: currentSteps,
              lastPassiveCoinTime: now,
              coinsEarnedToday: finalCoins,
            },
            $inc: {
              coinsBalance: finalCoins,
            },
          }
        : {
            $set: {
              lastCoinDate: today,
              lastPassiveCoinSteps: currentSteps,
              lastPassiveCoinTime: now,
            },
            $inc: {
              coinsBalance: finalCoins,
              coinsEarnedToday: finalCoins,
            },
          };

      const atomicResult = await Gamification.findOneAndUpdate(
        {
          user: userId,
          $or: [
            { lastPassiveCoinSteps: { $lte: previousSteps } },
            { lastPassiveCoinSteps: null },
            { lastPassiveCoinSteps: { $exists: false } },
          ],
        },
        updateOp,
        { new: true }
      );

      if (!atomicResult) { skipReasons.raceLost++; continue; } // watermark moved by another process

      // Log transaction
      logCoinTransaction({
        userId,
        type: 'EARNED',
        amount: finalCoins,
        balanceAfter: atomicResult.coinsBalance,
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
  console.log(
    `[CRON:PassiveCoins] Skips — blocked:${skipReasons.blocked} noNewSteps:${skipReasons.noNewSteps} recentSync:${skipReasons.recentSync} capReached:${skipReasons.capReached} raceLost:${skipReasons.raceLost}`
  );

  return { processed, awarded, totalCoins: totalCoinsAwarded, skipReasons };
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
