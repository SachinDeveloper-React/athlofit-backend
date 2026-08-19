// src/utils/cheatPenalty.js
//
// Anti-cheat penalty system.
//
// When a step submission is judged IMPLAUSIBLE by stepValidation, this module:
//   1. Records the flag in the CheatFlag collection (always — this is data).
//   2. Counts how many flags the user has received today.
//   3. If penalties are enabled and the count reaches DAILY_FLAG_THRESHOLD, sets
//      coinBlockedUntil = today + BLOCK_DURATION_DAYS.
//   4. If penalties are enabled, pushes a warning on each flag and on the block.
//
// Only DEVICE step cheats reach here. Bonus steps (admin/agent credited) are not
// validated against these rules and are never flagged.
//
// ── Why this was switched off, and what had to change before switching it back ──
//
// The whole module was commented out in "comment anticheat code... Suspicious
// functionility in backend". That was the right call at the time, and the reason
// is visible in what the same commit did to stepValidation.js: it also commented
// out `flagged` there, in code that read
//
//     steps = existingWalked + maxPossible;
//
// i.e. the 5,000-step ratchet era, when the rate rules GRANTED steps instead of
// capping them and therefore fired on essentially every sync. Wired to a
// three-flags-a-day threshold, this module was blocking honest users' coins for
// ten days at a time.
//
// The ratchet is fixed, but that alone did not make `flagged` safe to punish on.
// Being clamped stays routine: the rate ceiling measures against the time since
// steps were last accepted, which is often seconds, while a client's figure can
// legitimately jump by thousands at once when a paired smartwatch flushes its
// backlog into Health Connect. The server then walks the total up at the maximum
// rate, flagging on every sync until it converges — simulated against the current
// rules, an honest watch-backlog user is flagged on 40 of 40 syncs, exactly like a
// client posting 999,999.
//
// So the trigger is no longer `flagged`. It is `severity === 'implausible'`, which
// means the reported figure exceeds what any human could have walked in the
// elapsed day — something no real sensor produces. See the severity note in
// stepValidation.js.
//
// The punishment itself stays behind `features.cheatPenaltyEnabled`, default
// FALSE, so restoring this file changes nothing for users until that flag is
// turned on deliberately. Flags are still recorded while it is off, which is the
// point: it builds the evidence needed to decide whether turning it on is safe.

const CheatFlag = require('../models/CheatFlag.model');
const User = require('../models/User.model');
const { createNotification } = require('./createNotification');
const { todayISO } = require('./date');
// Pure and separately testable — see the note at the top of coinBlock.js.
const { isCoinBlocked } = require('./coinBlock');

const DAILY_FLAG_THRESHOLD = 3; // flags in a single day before block
const BLOCK_DURATION_DAYS = 10; // how many days coins are blocked

/**
 * Record a cheat flag and, when penalties are enabled, enforce the block.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.userId - The user ID
 * @param {string} params.reason - Why it was flagged (from stepValidation)
 * @param {number} params.incomingSteps - What client sent
 * @param {number} params.clampedSteps - What server accepted
 * @param {number} params.existingSteps - What was already in DB
 * @param {string} [params.date] - ISO date (defaults to today)
 * @param {boolean} [params.penaltyEnabled] - When false (the default), the flag is
 *   recorded silently: no notification, no coin block. Driven by
 *   `features.cheatPenaltyEnabled` in AppConfig.
 *
 * @returns {{ flagCount: number, blocked: boolean, coinBlockedUntil: Date|null }}
 */
async function recordCheatFlag({
  userId,
  reason,
  incomingSteps,
  clampedSteps,
  existingSteps,
  date,
  penaltyEnabled = false,
}) {
  const today = date || todayISO();

  try {
    // 1. Record the flag. This happens whether or not penalties are enabled —
    //    it is evidence, not punishment.
    await CheatFlag.create({
      user: userId,
      date: today,
      reason,
      incomingSteps,
      clampedSteps,
      existingSteps,
    });

    // 2. Count today's flags for this user
    const flagCount = await CheatFlag.countDocuments({ user: userId, date: today });

    // 3. With penalties off, stop here. Nothing user-visible happens.
    if (!penaltyEnabled) {
      return { flagCount, blocked: false, coinBlockedUntil: null };
    }

    // 4. Warning notification while the user still has chances left
    const remainingChances = Math.max(0, DAILY_FLAG_THRESHOLD - flagCount);

    if (flagCount < DAILY_FLAG_THRESHOLD) {
      createNotification(userId, {
        type: 'SECURITY',
        title: '⚠️ Suspicious Step Activity Detected',
        message: `We detected unusual step data from your device. Warning ${flagCount}/${DAILY_FLAG_THRESHOLD}. If this happens ${remainingChances} more time${remainingChances > 1 ? 's' : ''} today, your coin earnings will be blocked for ${BLOCK_DURATION_DAYS} days.`,
        data: { screen: 'Tracker', alert: 'cheat_warning', flagCount: String(flagCount) },
      });

      return { flagCount, blocked: false, coinBlockedUntil: null };
    }

    // 5. Threshold reached — block coin earnings
    const blockUntil = new Date();
    blockUntil.setDate(blockUntil.getDate() + BLOCK_DURATION_DAYS);

    // Only extend an existing block, never shorten it.
    await User.findByIdAndUpdate(
      userId,
      [
        {
          $set: {
            coinBlockedUntil: {
              $cond: {
                if: { $gt: [blockUntil, { $ifNull: ['$coinBlockedUntil', new Date(0)] }] },
                then: blockUntil,
                else: '$coinBlockedUntil',
              },
            },
          },
        },
      ]
    );

    // Mark the triggering flag
    await CheatFlag.findOneAndUpdate(
      { user: userId, date: today, triggeredBlock: false },
      { $set: { triggeredBlock: true } },
      { sort: { createdAt: -1 } }
    );

    createNotification(userId, {
      type: 'SECURITY',
      title: '🚫 Coin Earnings Blocked — Fake Steps Detected',
      message: `You submitted suspicious step data ${flagCount} times today. Your coin earnings (including automatic coins) are now blocked for ${BLOCK_DURATION_DAYS} days until ${blockUntil.toISOString().slice(0, 10)}. Please use the app honestly.`,
      data: { screen: 'Tracker', alert: 'cheat_blocked', blockedUntil: blockUntil.toISOString() },
    });

    return { flagCount, blocked: true, coinBlockedUntil: blockUntil };
  } catch (err) {
    console.error('[cheatPenalty] Error recording flag:', err.message);
    // Non-fatal — never break the sync flow over bookkeeping.
    return { flagCount: 0, blocked: false, coinBlockedUntil: null };
  }
}

module.exports = { recordCheatFlag, isCoinBlocked, DAILY_FLAG_THRESHOLD, BLOCK_DURATION_DAYS };
