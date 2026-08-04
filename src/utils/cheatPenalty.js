// src/utils/cheatPenalty.js
//
// Anti-cheat penalty system.
//
// When a user submits fake/manipulated device steps and the stepValidation
// flags the submission, this module:
//   1. Records the flag in CheatFlag collection.
//   2. Counts how many flags the user has received TODAY.
//   3. If count >= 3 in a single day, sets coinBlockedUntil = today + 10 days.
//   4. Sends push notifications to warn the user on each flag and on block.
//
// IMPORTANT: This only applies to DEVICE step cheats.
//            Bonus steps (admin/agent credited) are NOT flagged here.

const CheatFlag = require('../models/CheatFlag.model');
const User = require('../models/User.model');
const { createNotification } = require('./createNotification');
const { todayISO } = require('./date');

const DAILY_FLAG_THRESHOLD = 3; // flags in a single day before block
const BLOCK_DURATION_DAYS = 10; // how many days coins are blocked

/**
 * Record a cheat flag and enforce the penalty if threshold is reached.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.userId - The user ID
 * @param {string} params.reason - Why it was flagged (from stepValidation)
 * @param {number} params.incomingSteps - What client sent
 * @param {number} params.clampedSteps - What server accepted
 * @param {number} params.existingSteps - What was already in DB
 * @param {string} [params.date] - ISO date (defaults to today)
 *
 * @returns {{ flagCount: number, blocked: boolean, coinBlockedUntil: Date|null }}
 */
async function recordCheatFlag({ userId, reason, incomingSteps, clampedSteps, existingSteps, date }) {
  // ── SUSPICIOUS FUNCTIONALITY DISABLED ────────────────────────────────────
  // The entire cheat-flag recording and coin-blocking penalty is commented out.
  // To re-enable, remove the early return below and uncomment the body.
  return { flagCount: 0, blocked: false, coinBlockedUntil: null };

  // const today = date || todayISO();

  // try {
  //   // 1. Record the flag
  //   await CheatFlag.create({
  //     user: userId,
  //     date: today,
  //     reason,
  //     incomingSteps,
  //     clampedSteps,
  //     existingSteps,
  //   });

  //   // 2. Count today's flags for this user
  //   const flagCount = await CheatFlag.countDocuments({ user: userId, date: today });

  //   // 3. Send warning notification on each flag
  //   const remainingChances = Math.max(0, DAILY_FLAG_THRESHOLD - flagCount);

  //   if (flagCount < DAILY_FLAG_THRESHOLD) {
  //     // Warning notification — user still has chances left
  //     createNotification(userId, {
  //       type: 'SECURITY',
  //       title: '⚠️ Suspicious Step Activity Detected',
  //       message: `We detected unusual step data from your device. Warning ${flagCount}/${DAILY_FLAG_THRESHOLD}. If this happens ${remainingChances} more time${remainingChances > 1 ? 's' : ''} today, your coin earnings will be blocked for ${BLOCK_DURATION_DAYS} days.`,
  //       data: { screen: 'Tracker', alert: 'cheat_warning', flagCount: String(flagCount) },
  //     });

  //     return { flagCount, blocked: false, coinBlockedUntil: null };
  //   }

  //   // 4. Threshold reached — block coin earnings for 10 days
  //   const blockUntil = new Date();
  //   blockUntil.setDate(blockUntil.getDate() + BLOCK_DURATION_DAYS);

  //   // Update user with the block date (only extend if new block is later)
  //   await User.findByIdAndUpdate(
  //     userId,
  //     [
  //       {
  //         $set: {
  //           coinBlockedUntil: {
  //             $cond: {
  //               if: { $gt: [blockUntil, { $ifNull: ['$coinBlockedUntil', new Date(0)] }] },
  //               then: blockUntil,
  //               else: '$coinBlockedUntil',
  //             },
  //           },
  //         },
  //       },
  //     ]
  //   );

  //   // Mark the triggering flag
  //   await CheatFlag.findOneAndUpdate(
  //     { user: userId, date: today, triggeredBlock: false },
  //     { $set: { triggeredBlock: true } },
  //     { sort: { createdAt: -1 } }
  //   );

  //   // 5. Send block notification
  //   createNotification(userId, {
  //     type: 'SECURITY',
  //     title: '🚫 Coin Earnings Blocked — Fake Steps Detected',
  //     message: `You submitted suspicious step data ${flagCount} times today. Your coin earnings (including automatic coins) are now blocked for ${BLOCK_DURATION_DAYS} days until ${blockUntil.toISOString().slice(0, 10)}. Please use the app honestly.`,
  //     data: { screen: 'Tracker', alert: 'cheat_blocked', blockedUntil: blockUntil.toISOString() },
  //   });

  //   return { flagCount, blocked: true, coinBlockedUntil: blockUntil };
  // } catch (err) {
  //   console.error('[cheatPenalty] Error recording flag:', err.message);
  //   // Non-fatal — don't break the sync flow
  //   return { flagCount: 0, blocked: false, coinBlockedUntil: null };
  // }
}

/**
 * Check if a user is currently blocked from earning coins.
 *
 * @param {Object} user - The user document (must have coinBlockedUntil field)
 * @returns {{ isBlocked: boolean, blockedUntil: Date|null, daysRemaining: number }}
 */
function isCoinBlocked(user) {
  // ── SUSPICIOUS FUNCTIONALITY DISABLED ────────────────────────────────────
  // Coin blocking based on suspicious step activity is commented out.
  // Always returns not-blocked so all users can earn coins freely.
  return { isBlocked: false, blockedUntil: null, daysRemaining: 0 };

  // if (!user.coinBlockedUntil) {
  //   return { isBlocked: false, blockedUntil: null, daysRemaining: 0 };
  // }

  // const now = new Date();
  // const blockedUntil = new Date(user.coinBlockedUntil);

  // if (now >= blockedUntil) {
  //   // Block has expired
  //   return { isBlocked: false, blockedUntil: null, daysRemaining: 0 };
  // }

  // const daysRemaining = Math.ceil((blockedUntil - now) / (1000 * 60 * 60 * 24));
  // return { isBlocked: true, blockedUntil, daysRemaining };
}

module.exports = { recordCheatFlag, isCoinBlocked, DAILY_FLAG_THRESHOLD, BLOCK_DURATION_DAYS };
