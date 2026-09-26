// src/crons/stepCoinSettlement.js
//
// Pays the step coins that waited for their day to be over.
//
// Every pending award for a date before today (IST) is judged against its
// whole day — see utils/stepCoinSettlement.js for how — and either moved into
// the balance, in full or in part, or refused. Paid coins are logged to the
// ledger under the source they were earned under, so a user's history reads
// the same as it always did, one day later.
//
// Runs daily from the in-process scheduler and from POST /cron/settle-step-coins
// for the external crontab. Safe to run twice at once and safe to re-run: each
// award moves out of `pending` exactly once, by a conditional update, before
// any coins move.
//
// Runs whether or not `features.stepCoinSettlement` is on, so switching the
// feature off never strands coins that were recorded while it was on.
//
// ── The day itself, not just its coins ──────────────────────────────────────
//
// A day that does not verify in full is also corrected where it is stored:
// its steps come down to what was verified, distance, calories and active
// minutes with them, and `goalMet` is re-decided on the verified total. It is
// then closed, so the seven-day re-sync every phone runs cannot raise it back
// up. What it held before is kept in `stepVerification`.
//
// If that takes the goal away, the day comes out of the streak as well — the
// streak counted it when it synced, on steps that turned out not to be walked.
// See withdrawStreakDay in utils/streak.js.

const PendingCoin = require('../models/PendingCoin.model');
const HealthActivity = require('../models/HealthActivity.model');
const Gamification = require('../models/Gamification.model');
const BadgeDefinition = require('../models/BadgeDefinition.model');
const { todayISO } = require('../utils/date');
const { logCoinTransaction } = require('../utils/logCoinTransaction');
const { createNotification } = require('../utils/createNotification');
const {
  verifyDay,
  settlementFor,
  datesThrough,
} = require('../utils/stepCoinSettlement');
const { withdrawStreakDay } = require('../utils/streak');

/** What verifyDay reads off a row. */
const DAY_FIELDS =
  'date steps bonusSteps distance calories activeMinutes sharedHeld ' +
  'cadenceBySource priorStuckSamples stepBaseline lastIncomingSteps ' +
  'goalMet goalSnapshot';

const round4 = v => parseFloat((Number(v) || 0).toFixed(4));
const shown = v => (Math.round(v * 100) / 100).toLocaleString('en-IN');

/** "2026-09-23" → "23 Sep", for a notification. */
function shortDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * Take a day back out of the streak. Compare-and-swap on the streak cursor, so
 * a sync that moves the streak meanwhile makes this re-read rather than
 * overwrite it.
 *
 * @returns {Promise<object|null>} What changed, or null if nothing did.
 */
async function withdrawFromStreak({ userId, date }) {
  const [rows, badgeDefs] = await Promise.all([
    HealthActivity.find({ user: userId, goalMet: true }).select('date').lean(),
    BadgeDefinition.find({}).select('key threshold').lean(),
  ]);
  const goalMetDates = rows.map(r => r.date).filter(d => d !== date);

  for (let attempt = 0; attempt < 3; attempt++) {
    const gam = await Gamification.findOne({ user: userId }).lean();
    if (!gam) return null;
    const change = withdrawStreakDay(gam, date, { goalMetDates, badgeDefs });
    if (!change) return null;

    const $set = {
      streakDays: change.streakDays,
      bestStreakDays: change.bestStreakDays,
      lastFreezeGrantStreak: change.lastFreezeGrantStreak,
    };
    if (change.clearBadges.length) {
      $set.badgeList = (gam.badgeList || []).map(b =>
        change.clearBadges.includes(b.key)
          ? { ...b, unlocked: false, unlockedAt: null, payoutEligible: false }
          : b,
      );
    }
    const result = await Gamification.updateOne(
      { user: userId, streakDays: gam.streakDays, lastActiveDate: gam.lastActiveDate },
      { $set },
    );
    if (result.matchedCount > 0) {
      console.warn(
        `[CRON:StepSettlement] user ${userId} ${date} withdrawn from the streak: ` +
          `${gam.streakDays} → ${change.streakDays} days` +
          (change.clearBadges.length ? `; badges cleared: ${change.clearBadges.join(', ')}` : '') +
          (change.paidBadges.length
            ? `; badges already paid, NOT touched: ${change.paidBadges.join(', ')}`
            : ''),
      );
      return change;
    }
  }
  return null;
}

/**
 * Lower a day that did not verify in full to what did, and close it.
 *
 * @returns {Promise<boolean>} Whether the day's goal was taken away.
 */
async function correctDay({ userId, row, verdict }) {
  const steps = verdict.payableWalked + verdict.bonus;
  const goal = Number(row.goalSnapshot) > 0 ? Number(row.goalSnapshot) : 10_000;
  const goalMet = steps >= goal;
  const goalMetBefore = row.goalMet === true;

  // Conditioned on the stored total still being above the verified one, so a
  // second run over the same day changes nothing.
  const before = await HealthActivity.findOneAndUpdate(
    { user: userId, date: row.date, steps: { $gt: steps } },
    {
      $set: {
        steps,
        goalMet,
        distance: Math.round(verdict.distance * verdict.ratio * 100) / 100,
        calories: Math.round(verdict.calories * verdict.ratio),
        activeMinutes: Math.round(verdict.activeMinutes * verdict.ratio),
        stuckClosed: true,
        stepVerification: {
          status: verdict.status,
          walkedBefore: verdict.walked,
          payableWalked: verdict.payableWalked,
          goalMetBefore,
          reason: verdict.reason,
          at: new Date(),
        },
      },
    },
    { new: false },
  );
  if (!before) return false;

  if (goalMetBefore && !goalMet) {
    await withdrawFromStreak({ userId, date: row.date });
    return true;
  }
  return false;
}

/**
 * Settle one user's pending awards for one date.
 *
 * @returns {Promise<{ entries: number, paidCoins: number, refusedCoins: number,
 *   status: string, reason: string|null }|null>} null when nothing was pending.
 */
async function settleDay({ userId, date }) {
  const entries = await PendingCoin.find({ user: userId, date, status: 'pending' })
    .sort({ createdAt: 1 })
    .lean();
  if (!entries.length) return null;

  // Every date an award is judged against: the day itself, and for a weekly
  // challenge each day of its week up to that one.
  const dates = new Set([date]);
  for (const e of entries) {
    if (e.metadata?.challengeType === 'weekly' && e.metadata.weekStart) {
      for (const d of datesThrough(e.metadata.weekStart, e.date)) dates.add(d);
    }
  }
  const rows = await HealthActivity.find({ user: userId, date: { $in: [...dates] } })
    .select(DAY_FIELDS)
    .lean();
  const byDate = new Map(rows.map(r => [r.date, r]));
  const verdicts = new Map();
  const verdictFor = d => {
    if (!verdicts.has(d)) verdicts.set(d, verifyDay(byDate.get(d) || null, d));
    return verdicts.get(d);
  };

  let paidCoins = 0;
  let refusedCoins = 0;

  for (const entry of entries) {
    const { pay, reason } = settlementFor(entry, verdictFor);
    const payable = Math.min(round4(pay), round4(entry.amount));

    // Claimed before any coins move, so a concurrent run cannot pay it twice.
    const claimed = await PendingCoin.findOneAndUpdate(
      { _id: entry._id, status: 'pending' },
      {
        $set: {
          status: payable > 0 ? 'settled' : 'refused',
          settledAmount: payable,
          reason: payable < entry.amount ? reason : null,
          settledAt: new Date(),
        },
      },
      { new: true },
    );
    if (!claimed) continue;

    if (payable > 0) {
      const gam = await Gamification.findOneAndUpdate(
        { user: userId },
        { $inc: { coinsBalance: payable } },
        { new: true },
      );
      if (!gam) {
        // Put it back rather than mark coins paid that never arrived; the next
        // run tries again.
        await PendingCoin.updateOne(
          { _id: entry._id },
          { $set: { status: 'pending', settledAmount: 0, reason: null, settledAt: null } },
        ).catch(() => {});
        console.error(
          `[CRON:StepSettlement] No Gamification row for user ${userId}; ${payable} coins left pending`,
        );
        continue;
      }
      paidCoins += payable;

      await logCoinTransaction({
        userId,
        type: 'EARNED',
        amount: payable,
        balanceAfter: gam.coinsBalance,
        source: entry.source,
        description:
          payable < entry.amount
            ? `${entry.description} (${shown(payable)} of ${shown(entry.amount)} verified)`
            : entry.description,
        metadata: { ...(entry.metadata || {}), date: entry.date, trigger: 'settlement' },
      });
    }
    refusedCoins += round4(entry.amount - payable);
  }

  paidCoins = round4(paidCoins);
  refusedCoins = round4(refusedCoins);
  const verdict = verdictFor(date);

  const row = byDate.get(date) || null;
  const goalWithdrawn =
    row && (verdict.status === 'partial' || verdict.status === 'refused')
      ? await correctDay({ userId, row, verdict })
      : false;

  // One message per day settled. Someone whose coins were held back is told
  // why, in words that do not accuse, with a way to ask — a false positive is
  // survivable only if the person it lands on hears about it.
  if (paidCoins > 0 || refusedCoins > 0) {
    const day = shortDate(date);
    let title;
    let message;
    if (refusedCoins <= 0) {
      title = '🪙 Step coins added';
      message = `${shown(paidCoins)} coins for your steps on ${day} have been added to your balance.`;
    } else if (paidCoins > 0) {
      title = '🪙 Step coins added';
      message =
        `${shown(paidCoins)} coins for ${day} have been added. ${shown(refusedCoins)} could not be ` +
        `verified — ${verdict.reason || 'the activity could not be verified'}. ` +
        'Contact support if you think this is a mistake.';
    } else {
      title = '⚠️ Step coins not added';
      message =
        `${shown(refusedCoins)} coins for ${day} could not be verified — ` +
        `${verdict.reason || 'the activity could not be verified'}. ` +
        'Contact support if you think this is a mistake.';
    }
    if (goalWithdrawn) message += ' This day no longer counts toward your streak.';
    createNotification(userId, { type: 'COIN', title, message, data: { screen: 'CoinsScreen' } });
  }

  return {
    entries: entries.length,
    paidCoins,
    refusedCoins,
    goalWithdrawn,
    status: verdict.status,
    reason: verdict.reason,
  };
}

/**
 * Settle every pending award for a date before `today`.
 *
 * @param {object} [params]
 * @param {string} [params.today] - "YYYY-MM-DD"; defaults to today in IST.
 */
async function settleStepCoins({ today = todayISO() } = {}) {
  const groups = await PendingCoin.aggregate([
    { $match: { status: 'pending', date: { $lt: today } } },
    { $group: { _id: { user: '$user', date: '$date' } } },
    { $sort: { '_id.date': 1 } },
  ]);

  const totals = {
    days: 0,
    entries: 0,
    paidCoins: 0,
    refusedCoins: 0,
    refusedDays: 0,
    errors: 0,
  };

  for (const { _id } of groups) {
    try {
      const result = await settleDay({ userId: _id.user, date: _id.date });
      if (!result) continue;
      totals.days += 1;
      totals.entries += result.entries;
      totals.paidCoins = round4(totals.paidCoins + result.paidCoins);
      totals.refusedCoins = round4(totals.refusedCoins + result.refusedCoins);
      if (result.refusedCoins > 0) {
        totals.refusedDays += 1;
        console.warn(
          `[CRON:StepSettlement] user ${_id.user} ${_id.date}: paid ${result.paidCoins}, ` +
            `held back ${result.refusedCoins} (${result.status}) — ${result.reason}`,
        );
      }
    } catch (err) {
      totals.errors += 1;
      console.error(
        `[CRON:StepSettlement] user ${_id.user} ${_id.date} failed:`,
        err.message,
      );
    }
  }

  console.log(
    `[CRON:StepSettlement] Done — ${totals.days} day(s), ${totals.entries} award(s): ` +
      `${totals.paidCoins} coins paid, ${totals.refusedCoins} held back on ` +
      `${totals.refusedDays} day(s), ${totals.errors} error(s)`,
  );
  return totals;
}

module.exports = { settleStepCoins, settleDay };
