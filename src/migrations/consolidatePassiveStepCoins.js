/**
 * Migration: Consolidate duplicate PASSIVE_STEPS CoinTransactions
 *
 * Problem: The old system logged a PASSIVE_STEPS transaction on every health sync
 * (every 5 minutes), creating dozens of near-identical entries per day per user.
 *
 * Solution: This script consolidates those duplicates into 3-hour batches.
 * For each user, for each day, it:
 *   1. Groups all PASSIVE_STEPS transactions into 3-hour windows
 *   2. Keeps ONE transaction per window (the latest one with highest step count)
 *   3. Updates the kept entry's amount to the sum of all entries in that window
 *   4. Updates the description to show "previousSteps → currentSteps = delta"
 *   5. Deletes the duplicate entries
 *
 * Usage:
 *   node src/migrations/consolidatePassiveStepCoins.js
 *
 * Or call via admin endpoint:
 *   POST /admin/consolidate-passive-coins
 */

const mongoose = require('mongoose');

async function consolidatePassiveStepCoins(userId = null) {
  const CoinTransaction = require('../models/CoinTransaction.model');
  const Gamification = require('../models/Gamification.model');

  const matchFilter = { source: 'PASSIVE_STEPS' };
  if (userId) matchFilter.user = mongoose.Types.ObjectId(userId);

  // Get all affected users
  const userIds = await CoinTransaction.distinct('user', matchFilter);
  console.log(`[Migration] Found ${userIds.length} user(s) with PASSIVE_STEPS transactions`);

  let totalDeleted = 0;
  let totalKept = 0;

  for (const uid of userIds) {
    // Get all PASSIVE_STEPS transactions for this user, sorted by time
    const txns = await CoinTransaction.find({
      user: uid,
      source: 'PASSIVE_STEPS',
    }).sort({ createdAt: 1 }).lean();

    if (txns.length <= 1) {
      totalKept += txns.length;
      continue;
    }

    // Group by day + 3-hour window
    const windows = {};
    for (const txn of txns) {
      const date = new Date(txn.createdAt);
      const dayKey = date.toISOString().slice(0, 10); // YYYY-MM-DD
      const hourWindow = Math.floor(date.getHours() / 3); // 0-7 (8 windows per day)
      const windowKey = `${dayKey}_${hourWindow}`;

      if (!windows[windowKey]) windows[windowKey] = [];
      windows[windowKey].push(txn);
    }

    const idsToDelete = [];

    for (const [windowKey, group] of Object.entries(windows)) {
      if (group.length <= 1) {
        totalKept += 1;
        continue;
      }

      // Keep the LAST entry in the window (has the highest step count and final balance)
      const kept = group[group.length - 1];
      const duplicates = group.slice(0, -1);

      // Sum all amounts in this window into the kept entry
      const totalAmount = group.reduce((sum, t) => sum + t.amount, 0);

      // Determine step range for the window
      const firstSteps = group[0].metadata?.steps ?? 0;
      const lastSteps = kept.metadata?.steps ?? 0;

      // Find the previous window's last steps (for "previousSteps → currentSteps" format)
      // Use the first transaction's steps as the "previous" baseline for this window
      const previousSteps = firstSteps > 0
        ? (firstSteps - Math.round(group[0].amount / 0.005)) // approximate previous from first entry
        : 0;

      // Use metadata.steps from the first entry as previousSteps if available
      // The first entry in a window represents the state at window start
      const windowPreviousSteps = duplicates.length > 0
        ? (group[0].metadata?.previousSteps ?? Math.max(0, firstSteps - Math.round(group[0].amount * 200)))
        : 0;

      const stepDelta = lastSteps - windowPreviousSteps;

      // Update the kept entry
      await CoinTransaction.findByIdAndUpdate(kept._id, {
        $set: {
          amount: parseFloat(totalAmount.toFixed(2)),
          description: `Step Coins — ${windowPreviousSteps.toLocaleString()} → ${lastSteps.toLocaleString()} = ${Math.max(0, stepDelta).toLocaleString()} steps`,
          'metadata.previousSteps': windowPreviousSteps,
          'metadata.stepDelta': Math.max(0, stepDelta),
          'metadata.steps': lastSteps,
        },
      });

      // Collect duplicate IDs for batch deletion
      idsToDelete.push(...duplicates.map(t => t._id));
      totalKept += 1;
    }

    // Batch delete duplicates for this user
    if (idsToDelete.length > 0) {
      await CoinTransaction.deleteMany({ _id: { $in: idsToDelete } });
      totalDeleted += idsToDelete.length;
    }

    // Update the user's Gamification record with throttle markers
    const lastTxn = txns[txns.length - 1];
    await Gamification.findOneAndUpdate(
      { user: uid },
      {
        $set: {
          lastPassiveCoinTime: lastTxn.createdAt,
          lastPassiveCoinSteps: lastTxn.metadata?.steps ?? 0,
        },
      },
    );
  }

  const result = {
    usersProcessed: userIds.length,
    transactionsKept: totalKept,
    duplicatesRemoved: totalDeleted,
  };

  console.log('[Migration] Complete:', result);
  return result;
}

// ─── CLI runner ───────────────────────────────────────────────────────────────

if (require.main === module) {
  const { connectDB } = require('../config/db');

  (async () => {
    try {
      await connectDB();
      console.log('[Migration] Connected to database');

      const result = await consolidatePassiveStepCoins();
      console.log('[Migration] Result:', JSON.stringify(result, null, 2));

      process.exit(0);
    } catch (err) {
      console.error('[Migration] Error:', err);
      process.exit(1);
    }
  })();
}

module.exports = { consolidatePassiveStepCoins };
