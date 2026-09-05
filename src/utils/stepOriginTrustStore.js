// src/utils/stepOriginTrustStore.js
//
// Reads the origin history that stepOriginTrust reasons about.
//
// Split from the policy for the same reason stepBaselineStore is split from
// computeStepBaseline: the decision is pure and testable without a database,
// and the read can be reused by the reversal tooling to ask the same question
// about a day that has already been written.
//
// The source is StepProvenance, which already records the primary origin of
// every accepted increase and keeps 90 days. Nothing new has to be stored to
// answer "has this account been using this source?".

const StepProvenance = require('../models/StepProvenance.model');
const {
  ORIGIN_WINDOW_DAYS,
  ORIGIN_TRUST_MIN_DAYS,
} = require('./stepOriginTrust');
const { shiftDate } = require('./stepBaselineStore');

/**
 * The account's origin history for the days BEFORE `date`.
 *
 * Strictly before, for the same reason the baseline window is: today's own
 * reports must not be able to establish the source that today's steps are being
 * attributed to. An origin that could vouch for itself within the day would make
 * the rule a formality — post once to register, then post the real payload.
 *
 * Never throws. A failed read returns an empty history, which resolveOriginTrust
 * reads as "nothing is established". That is the safe direction for this
 * particular rule: its only effect is to keep a day out of the BASELINE window,
 * so failing this way costs a user nothing today and merely declines to widen
 * their allowance tomorrow. It never clamps anybody on its own.
 *
 * @param {object} params
 * @param {import('mongoose').Types.ObjectId|string} params.userId
 * @param {string} params.date - "YYYY-MM-DD" being validated.
 * @returns {Promise<{establishedOrigins: string[], distinctPrimaries: number}>}
 */
async function loadOriginHistory({ userId, date }) {
  const empty = { establishedOrigins: [], distinctPrimaries: 0 };
  try {
    const rows = await StepProvenance.find(
      {
        user: userId,
        date: { $gte: shiftDate(date, ORIGIN_WINDOW_DAYS), $lt: date },
      },
      { date: 1, 'entries.primaryOrigin': 1, _id: 0 },
    ).lean();

    // Counted in DISTINCT DAYS, not in entries. A day is one observation of "this
    // account was using this source"; the widget worker posting ninety times that
    // day is not ninety pieces of evidence, and counting entries would let a
    // single day's chatter establish an origin outright.
    const originDays = {};
    for (const row of rows) {
      const onThisDay = new Set();
      for (const entry of row.entries || []) {
        if (entry?.primaryOrigin) onThisDay.add(entry.primaryOrigin);
      }
      for (const origin of onThisDay) {
        originDays[origin] = (originDays[origin] || 0) + 1;
      }
    }

    // Resolved here, not at the call site. This whole read happens once per user
    // per day and is frozen on the row, so what it hands back has to be the
    // finished answer rather than the working data behind it.
    return {
      establishedOrigins: Object.entries(originDays)
        .filter(([, days]) => days >= ORIGIN_TRUST_MIN_DAYS)
        .map(([pkg]) => pkg),
      distinctPrimaries: Object.keys(originDays).length,
    };
  } catch (err) {
    console.error('[StepOriginTrust] history read failed:', err.message);
    return empty;
  }
}

module.exports = { loadOriginHistory };
