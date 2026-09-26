// src/utils/syncDateWindow.js
//
// Which dates a step sync may write to.
//
// POST /health/sync takes an explicit `date`, and it was only ever checked for
// shape and against the account's creation date. Two consequences:
//
//   * A FUTURE date was accepted. Its elapsed-day ceiling is today's, so at 22:00
//     a client could park up to its baseline ceiling — 15,000 for a new account —
//     on tomorrow's row, and on every day after it. When that day arrived the
//     row already held the steps, and the first same-day sync paid coins for
//     them: a full day of steps nobody walked, every day, for free.
//   * ANY past date after signup was accepted. No coins (the retro award stops at
//     seven days), but the history itself could be rewritten: leaderboards,
//     weekly challenge totals, and — worst — the trailing days the per-user
//     baseline ceiling is computed from. Raising an empty day from a month ago
//     raises the ceiling it is judged against, which is the ratchet that ceiling
//     exists to prevent.
//
// No honest client sends either. The Android workers and the JS background sync
// re-post at most the last seven days, the same window the retro coin award
// uses, and nothing posts ahead of the device's own today.

const { toClientDate, daysBetween } = require('./date');

/** How far back a sync may write. Matches the clients' re-post window and the retro coin window. */
const SYNC_BACKFILL_DAYS = 7;

/**
 * Minutes a device clock may run ahead of the server before its "today" is
 * treated as the future. Covers the few seconds either side of midnight in which
 * a device can legitimately post the new date first.
 */
const CLOCK_SKEW_MIN = 10;

/**
 * @param {object} params
 * @param {string} params.date - "YYYY-MM-DD" the sync would write to.
 * @param {string|null} [params.timezone] - The client's timezone, as sent.
 * @param {Date} [params.now]
 * @returns {{ ok: true } | { ok: false, reason: 'future'|'too_old', message: string }}
 */
function checkSyncDate({ date, timezone = null, now = new Date() }) {
  const latest = toClientDate(new Date(now.getTime() + CLOCK_SKEW_MIN * 60_000), timezone);
  if (latest && date > latest) {
    return { ok: false, reason: 'future', message: 'Skipped — date is in the future' };
  }

  const clientToday = toClientDate(now, timezone);
  const age = clientToday ? daysBetween(date, clientToday) : null;
  if (age != null && age > SYNC_BACKFILL_DAYS) {
    return {
      ok: false,
      reason: 'too_old',
      message: `Skipped — date is more than ${SYNC_BACKFILL_DAYS} days old`,
    };
  }

  return { ok: true };
}

module.exports = { checkSyncDate, SYNC_BACKFILL_DAYS, CLOCK_SKEW_MIN };
