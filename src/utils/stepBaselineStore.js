// src/utils/stepBaselineStore.js
//
// Loads the trailing days a per-user step ceiling is computed from.
//
// The policy — how many days, which percentile, what the floor and roof are —
// lives in stepValidation.computeStepBaseline() and is pure. This file is only
// the read: it decides which rows count as history and hands their walked totals
// over. Splitting them that way is what lets the ceiling be tested without a
// database, and lets the reversal tooling recompute a baseline for a past date
// with the same policy the sync path used.
//
// ── Why this is a lazy read and not a cron ──────────────────────────────────
//
// The obvious alternative is a nightly job that stamps a baseline onto every
// user. It would do far more work — every account, whether or not it is still
// active — and it would be wrong for exactly the accounts that matter, since a
// user who returns after a month gets a stale figure until the next run.
//
// Reading it on the day's first step sync costs one indexed range query per
// active user per day, on the {user, date} index the row lookup already uses,
// and the result is frozen onto that day's row (see HealthActivity.stepBaseline)
// so every later sync that day is free.

const HealthActivity = require('../models/HealthActivity.model');
const {
  computeStepBaseline,
  BASELINE_WINDOW_DAYS,
} = require('./stepValidation');

/**
 * "YYYY-MM-DD" shifted back by `days`.
 *
 * Deliberately UTC arithmetic on the calendar date rather than a timezone-aware
 * shift: the result is only ever used as the lower bound of a string range over
 * a field that is itself a plain calendar date, so the user's zone does not
 * enter into it. Being a day out at the far edge of a 28-day window cannot move
 * a percentile enough to matter, and pulling a timezone in here would make the
 * bound disagree with the keys it is compared against.
 */
function shiftDate(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

/**
 * This account's daily step ceiling for `date`, from the days before it.
 *
 * Strictly BEFORE: including the day under validation would let an inflated sync
 * raise the bound meant to refuse it.
 *
 * Never throws. A failed read returns null, which validateSteps reads as "not
 * characterised" and falls back to the population bounds — the pre-baseline
 * behaviour. A database hiccup must not be able to zero a user's step ceiling.
 *
 * @param {object} params
 * @param {import('mongoose').Types.ObjectId|string} params.userId
 * @param {string} params.date - "YYYY-MM-DD" being validated.
 * @returns {Promise<number|null>}
 */
async function loadStepBaseline({ userId, date }) {
  try {
    const rows = await HealthActivity.find(
      {
        user: userId,
        date: { $gte: shiftDate(date, BASELINE_WINDOW_DAYS), $lt: date },
        // Days whose steps were attributed to a source this account has no
        // history with are not evidence of what this account walks — see
        // HealthActivity.originTrusted and utils/stepOriginTrust.js.
        //
        // This is the rule that closes the ratchet. Without it a spoofer sitting
        // just under their ceiling every day would have those days counted as
        // history, raising the ceiling, and could climb from the floor to the
        // roof over two windows without ever tripping anything.
        //
        // `$ne: false` rather than `true`, so rows written before the field
        // existed still count. Absence means "never evaluated", not "suspect".
        originTrusted: { $ne: false },
      },
      { steps: 1, bonusSteps: 1, _id: 0 },
    ).lean();

    // Walked steps only. Bonus steps are credited by an admin or by the system
    // and say nothing about what this user walks, so letting them into the
    // history would raise the ceiling as a side effect of a support gesture.
    const walked = rows.map(r =>
      Math.max(0, (Number(r.steps) || 0) - (Number(r.bonusSteps) || 0)),
    );

    return computeStepBaseline(walked);
  } catch (err) {
    console.error('[StepBaseline] load failed:', err.message);
    return null;
  }
}

module.exports = { loadStepBaseline, shiftDate };
