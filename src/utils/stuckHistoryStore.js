// src/utils/stuckHistoryStore.js
//
// Loads the refused cadence samples an account carries into a new day.
//
// The policy — which holds were unmistakable enough to carry, and how many
// samples — lives in stepValidation.selectPriorStuckSamples() and is pure. This
// file is only the read, split the same way stepBaselineStore is split from
// computeStepBaseline, and frozen onto the day's row the same way: one indexed
// range query on the day's first step sync, then the stored list for every
// sync after it. See the note at PRIOR_STUCK_DAYS in stepValidation.js.

const HealthActivity = require('../models/HealthActivity.model');
const {
  selectPriorStuckSamples,
  PRIOR_STUCK_DAYS,
} = require('./stepValidation');
const { shiftDate } = require('./stepBaselineStore');

/**
 * The samples this account was refused on over the days before `date`.
 *
 * Strictly BEFORE, like the baseline: today's own samples are already judged
 * day-wide, and letting today's refusals feed back in as "earlier days" would
 * close a day on evidence from that same day.
 *
 * Only rows that held at all are read. A day released at least once carries a
 * forfeit; a day held until midnight never released, so it has none and is
 * found by its holder instead — or, once settlement has closed it, by that.
 *
 * Never throws. A failed read returns null, which the caller does not freeze,
 * so the next sync asks again. Failing to "nothing carried" is the safe
 * direction for an honest user: the day is judged on its own evidence, exactly
 * as before this existed.
 *
 * @param {object} params
 * @param {import('mongoose').Types.ObjectId|string} params.userId
 * @param {string} params.date - "YYYY-MM-DD" being written.
 * @returns {Promise<Array<{delta: number, rate: number|null, from: Date|null, at: Date}>|null>}
 */
async function loadPriorStuckSamples({ userId, date }) {
  try {
    const rows = await HealthActivity.find(
      {
        user: userId,
        date: { $gte: shiftDate(date, PRIOR_STUCK_DAYS), $lt: date },
        $or: [
          { stuckForfeit: { $gt: 0 } },
          { stuckSource: { $ne: null } },
          { stuckClosed: true },
        ],
      },
      { cadenceBySource: 1, _id: 0 },
    ).lean();

    return selectPriorStuckSamples(rows).map(s => ({
      delta: s.delta,
      rate: s.rate,
      from: s.from == null ? null : new Date(s.from),
      at: new Date(s.at),
    }));
  } catch (err) {
    console.error('[StuckHistory] load failed:', err.message);
    return null;
  }
}

module.exports = { loadPriorStuckSamples };
