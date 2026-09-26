// src/utils/pendingCoins.js
//
// The write side of step-coin settlement: recording an award as pending
// instead of paying it, and reading back what a user has waiting.
//
// Kept apart from utils/stepCoinSettlement.js, which is the pure policy, the
// same way stepBaselineStore is kept apart from computeStepBaseline.

const mongoose = require('mongoose');
const PendingCoin = require('../models/PendingCoin.model');
const { logCoinTransaction } = require('./logCoinTransaction');

/**
 * Record an earned award for settlement.
 *
 * Awaited by every caller, and never throws: the award's idempotency marker
 * has already been set by the time this runs, so a lost row would be coins
 * the user silently never sees. The failure is logged loudly instead.
 *
 * @returns {Promise<object|null>}
 */
async function recordPendingCoins({ userId, date, source, amount, description, metadata }) {
  try {
    if (!amount || amount <= 0) return null;
    return await PendingCoin.create({
      user: userId,
      date,
      source,
      amount: parseFloat(Number(amount).toFixed(4)),
      description,
      metadata: metadata || {},
    });
  } catch (err) {
    console.error(
      `[PendingCoins] FAILED to record ${amount} ${source} coins for user ${userId} on ${date}:`,
      err.message,
    );
    return null;
  }
}

/**
 * Log a step-coin award the way the current mode wants it: straight into the
 * ledger when it was paid, as a pending row when it waits for settlement.
 *
 * `date` is the activity date the coins are for. The rest is exactly what
 * logCoinTransaction takes, so a call site only has to say which mode it is in.
 */
async function logStepCoinAward({ pending, userId, date, source, amount, balanceAfter, description, metadata }) {
  if (!pending) {
    return logCoinTransaction({
      userId,
      type: 'EARNED',
      amount,
      balanceAfter,
      source,
      description,
      metadata,
    });
  }
  return recordPendingCoins({ userId, date, source, amount, description, metadata });
}

/**
 * Coins this user has earned and not yet been paid or refused.
 *
 * Summed from the rows rather than kept as a counter on the Gamification
 * document, so there is nothing to drift out of step with them.
 *
 * @returns {Promise<number>}
 */
async function pendingCoinsFor(userId) {
  try {
    const [row] = await PendingCoin.aggregate([
      {
        $match: {
          user: new mongoose.Types.ObjectId(String(userId)),
          status: 'pending',
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return parseFloat((row?.total || 0).toFixed(4));
  } catch (err) {
    console.error('[PendingCoins] total failed:', err.message);
    return 0;
  }
}

module.exports = { recordPendingCoins, logStepCoinAward, pendingCoinsFor };
