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
const { isStepsTrackingEnabled } = require('../utils/stepsTracking');
const {
  computePassiveCoinDelta,
  describePassiveCoinCap,
} = require('../utils/passiveCoins');
const {
  DEFAULT_RATE_PER_100_STEPS,
  DEFAULT_DAILY_EARN_LIMIT,
  DEFAULT_MAX_DAILY_REWARDS,
  DEFAULT_UNVERIFIED_DAILY_CAP,
} = require('../constants/coinDefaults');

// ─── Core distribution function ──────────────────────────────────────────────

async function distributePassiveCoins() {
  const today = todayISO();
  const now = new Date();

  // Load config
  let cfg = await AppConfig.findOne({ key: 'global' });
  if (!cfg) cfg = await AppConfig.create({ key: 'global' });

  const rate =
    cfg.coin_config?.steps?.rate_per_100_steps ?? DEFAULT_RATE_PER_100_STEPS;
  const dailyEarnLimit = cfg.coin?.dailyEarnLimit ?? DEFAULT_DAILY_EARN_LIMIT;
  const unverifiedDailyCap =
    cfg.coin?.unverifiedDailyCap ?? DEFAULT_UNVERIFIED_DAILY_CAP;

  // The passive daily cap and the per-step rate are stored independently and
  // nothing compared them, so the cap quietly stopped being reachable (0.095 per
  // 100 steps pays at most 47.5 coins/day against a limit of 200). This run is
  // the recurring place that sees both values, so it is where the mismatch gets
  // said out loud instead of being inferred from payouts.
  const capState = describePassiveCoinCap(rate, dailyEarnLimit);
  if (!capState.capBinds) {
    console.warn(`[CRON:PassiveCoins] ${capState.summary}`);
  }

  // Find all users who have health activity today (meaning they synced steps)
  // bonusSteps is selected so walked steps can be derived — see the comment on
  // `currentSteps` in the loop below.
  const activities = await HealthActivity.find({ date: today, steps: { $gt: 0 } })
    .select('user steps bonusSteps')
    .lean();

  if (activities.length === 0) {
    console.log(`[CRON:PassiveCoins] No activities for ${today}. Skipping.`);
    return { processed: 0, awarded: 0, totalCoins: 0 };
  }

  // Batch-load user verification + cheat-block status in one query
  const userIds = activities.map(a => a.user);
  const users = await User.find({ _id: { $in: userIds } })
    .select('_id emailVerified coinBlockedUntil stepsTracking')
    .lean();
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  let processed = 0;
  let awarded = 0;
  let totalCoinsAwarded = 0;
  const skipReasons = { blocked: 0, stepsPaused: 0, noNewSteps: 0, recentSync: 0, capReached: 0, raceLost: 0 };
  const debug = process.env.CRON_DEBUG === 'true';

  for (const activity of activities) {
    const userId = activity.user;

    // WALKED steps, bonus excluded.
    //
    // `activity.steps` is walked + bonus. Using it here put this cron on a
    // different basis from the health sync, which computes the same watermark
    // from walked steps only — and because both write the SAME field
    // (lastPassiveCoinSteps), the mismatch broke the sync:
    //
    //   cron pays on (walked + bonus) and sets watermark = walked + bonus
    //   → sync then tests `walked > walked + bonus`, which is never true
    //   → every real step the user walks for the rest of that day earns nothing.
    //
    // Deriving walked steps here puts both writers on one basis, so the watermark
    // means the same thing whoever moved it last. It also stops passive coins
    // being paid on admin-credited steps, which was never the intent — bonus
    // steps still count toward the goal, which pays its own separate bonus.
    const currentSteps = Math.max(0, (activity.steps || 0) - (activity.bonusSteps || 0));

    try {
      // Get or create gamification record
      let gam = await Gamification.findOne({ user: userId });
      if (!gam) {
        gam = await Gamification.create({ user: userId });
      }

      processed++;

      // ── Anti-cheat: skip if user is blocked from earning coins ─────────────
      // Reads not-blocked for everyone while features.cheatPenaltyEnabled is off,
      // since nothing writes coinBlockedUntil in that state.
      const userDoc = userMap.get(userId.toString());
      if (userDoc && isCoinBlocked(userDoc).isBlocked) { skipReasons.blocked++; continue; }

      // Step tracking paused for this account by an admin.
      //
      // The sync endpoint refuses NEW steps, but this cron pays out against
      // steps already stored today whose watermark has not caught up — so
      // without this check a paused user keeps earning step coins for hours
      // after the pause, from the very data the pause was meant to stop
      // crediting. The switch is supposed to stop step-derived earning, not
      // just step ingestion.
      if (userDoc && !isStepsTrackingEnabled(userDoc)) { skipReasons.stepsPaused++; continue; }

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
      const overallCap = cfg.coin?.maxDailyRewards ?? DEFAULT_MAX_DAILY_REWARDS;
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

      // Mirror the payout onto this DATE's own watermark, same as the health sync
      // does. lastPassiveCoinSteps above tracks only the current day, so without
      // this a date re-synced later as a PAST date would read its retro watermark
      // as 0 and be paid all over again.
      await HealthActivity.updateOne(
        { user: userId, date: today },
        { $max: { stepCoinWatermark: currentSteps } }
      ).catch(() => { /* non-fatal: the retro path re-checks anyway */ });

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

// ─── EOD Step Goal Auto-Claim ────────────────────────────────────────────────
// At end of day, check all users whose steps >= dailyStepGoal but didn't get
// stepGoalCoinDate set for today. This catches edge cases where:
//   - Steps were synced via background but goal coin wasn't claimed
//   - Health sync race condition missed the auto-award
//   - User had steps from native worker but never opened the app

async function eodAutoClaimStepGoal() {
  const today = todayISO();

  // Load config
  let cfg = await AppConfig.findOne({ key: 'global' });
  if (!cfg) cfg = await AppConfig.create({ key: 'global' });

  const stepGoalCoins = cfg.coin_config?.rewards?.daily_step_goal_reached?.coin_value
    ?? cfg.rewards?.stepGoalCoins ?? 50;
  const stepGoalEnabled = cfg.coin_config?.rewards?.daily_step_goal_reached?.enabled ?? true;

  if (!stepGoalEnabled) {
    console.log('[CRON:EOD-GoalClaim] Step goal reward is disabled. Skipping.');
    return { claimed: 0, skipped: 0 };
  }

  // Find all users who met their goal today but haven't been awarded
  // We need to join HealthActivity (has steps) with User (has dailyStepGoal)
  // and Gamification (has stepGoalCoinDate)
  const activities = await HealthActivity.find({ date: today, goalMet: true })
    .select('user steps')
    .lean();

  if (activities.length === 0) {
    console.log(`[CRON:EOD-GoalClaim] No goal-met activities for ${today}. Skipping.`);
    return { claimed: 0, skipped: 0 };
  }

  const userIds = activities.map(a => a.user);

  // Batch load users for coin-block check
  const users = await User.find({ _id: { $in: userIds } })
    .select('_id emailVerified coinBlockedUntil stepsTracking')
    .lean();
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  let claimed = 0;
  let skipped = 0;

  for (const activity of activities) {
    const userId = activity.user;

    try {
      // Skip if user is coin-blocked (no-op while penalties are disabled).
      const userDoc = userMap.get(userId.toString());
      if (userDoc && isCoinBlocked(userDoc).isBlocked) {
        skipped++;
        continue;
      }

      // Same reasoning as the passive payout above: a paused account must not
      // collect the daily step-goal bonus for a goal met from data the pause
      // exists to stop crediting.
      if (userDoc && !isStepsTrackingEnabled(userDoc)) {
        skipped++;
        continue;
      }

      // Atomically award step goal coins ONLY if not already awarded today
      const atomicResult = await Gamification.findOneAndUpdate(
        {
          user: userId,
          $or: [
            { stepGoalCoinDate: { $ne: today } },
            { stepGoalCoinDate: null },
          ],
        },
        {
          $set: { stepGoalCoinDate: today },
          $inc: {
            coinsBalance: stepGoalCoins,
            coinsEarnedToday: stepGoalCoins,
          },
          $push: {
            claimHistory: {
              $each: [{
                rewardId: 'steps_daily_eod',
                amount: stepGoalCoins,
                source: 'Daily Step Goal — EOD Auto Claim',
                createdAt: new Date(),
              }],
              $slice: -50,
            },
          },
        },
        { new: true }
      );

      if (atomicResult) {
        claimed++;

        logCoinTransaction({
          userId,
          type: 'EARNED',
          amount: stepGoalCoins,
          balanceAfter: atomicResult.coinsBalance,
          source: 'DAILY_STEP_GOAL_AUTO',
          description: `Daily Step Goal — EOD auto-claim (${activity.steps.toLocaleString()} steps)`,
          metadata: {
            steps: activity.steps,
            date: today,
            trigger: 'eod_cron',
          },
        });
      } else {
        skipped++; // Already claimed today via sync or manual
      }
    } catch (err) {
      console.error(`[CRON:EOD-GoalClaim] Error for user ${userId}:`, err.message);
    }
  }

  console.log(
    `[CRON:EOD-GoalClaim] Done — ${claimed} users auto-claimed, ${skipped} skipped (already claimed or blocked)`
  );

  return { date: today, claimed, skipped, totalChecked: activities.length };
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
  // Also auto-claims step goal reward for users who met goal but didn't claim.
  cron.schedule('50 59 23 * * *', () => {
    console.log('[CRON:PassiveCoins] Running EOD final distribution...');
    distributePassiveCoins().catch(err =>
      console.error('[CRON:PassiveCoins] EOD job failed:', err.message)
    );

    console.log('[CRON:EOD-GoalClaim] Running EOD step goal auto-claim...');
    eodAutoClaimStepGoal().catch(err =>
      console.error('[CRON:EOD-GoalClaim] EOD job failed:', err.message)
    );
  }, { timezone: 'Asia/Kolkata' });

  console.log('⏰ Passive coin cron scheduled (IST): every 3h (0,3,6,9,12,15,18,21) + EOD @23:59:50 (+ step goal auto-claim)');
}

module.exports = { startPassiveCoinCron, distributePassiveCoins, eodAutoClaimStepGoal };
