// src/utils/stepCoinSettlement.js
//
// What a finished day's step coins are worth, once the whole day can be seen.
//
// ── Why coins wait for the day to end ───────────────────────────────────────
//
// Every rule in stepValidation.js decides one sync at a time, and a machine
// moving a phone cannot be told apart from a person in one sync: 2,250 steps
// in fifteen minutes is a brisk walk. The pattern shows only across many
// syncs, so live it took ninety minutes to see — and the coins for those
// ninety minutes were already in the balance. On 23 Sep one account was paid
// for 15,000 steps, the goal bonus and the step challenges, from a day whose
// raw figures ran at ~150 steps/min, flat, for eleven hours.
//
// Seen whole, the same day is unambiguous from its first window. So with
// `features.stepCoinSettlement` on, step coins are not paid as they are earned:
// each award is recorded as pending (models/PendingCoin.model.js), and after
// the day is over the settlement job asks this file how much of it to pay.
//
// ── What a day is worth ─────────────────────────────────────────────────────
//
// verifyDay() answers with the day's PAYABLE walked steps:
//
//   * A day shared with another account's counter, and held for it, is worth
//     nothing. Live, the first matching samples go through because the second
//     copy is not visible yet; here every one of them is.
//   * A day on which any stream was refused at all is replayed with
//     hindsight: its samples go back through the live rules with the pattern
//     passed in as already-known evidence — the refused samples, and the
//     samples at the same rate before them that the live rule needed ninety
//     minutes to gather. Live, those ninety minutes were always paid, which
//     made them a daily allowance: a device run for two and a half hours a
//     day was held after ninety minutes and kept ~13,000 steps every time.
//     Replayed, the first sample in the pattern is refused.
//   * Where the pattern ran for three hours or more — the test that decides
//     which refusals are carried into the next day, see PRIOR_STUCK_DAYS in
//     stepValidation.js — the replay also CLOSES the day at its first return,
//     as live does for a carried pattern: a device that ran that long idles
//     in windows that look like walking. 23 Sep keeps 2,119 of 15,000. A
//     shorter pattern is only refused where it appears, so walking before and
//     after it still counts.
//   * Any other day is worth what it stored.
//
// The cost, stated plainly: a treadmill session steady enough to trip the
// live rule — ninety minutes within 5% — is now unpaid as a whole rather than
// from its ninety-first minute on. The walking around it is unaffected, the
// user is told, and the day's row keeps what it held before.
//
// settlementFor() then pays each pending award against that figure: passive
// coins for the part of their step range that is payable, the goal bonus if
// the payable total still meets the goal, a challenge if the payable figure
// still meets its target.
//
// ── Distance, calories and active minutes ───────────────────────────────────
//
// The client sends these as totals of its own, alongside the raw step count,
// and nothing on the server validates them. On a day that verifies in full
// they are taken as sent, exactly as live. On a day that does not, they are
// scaled by the share of the day's RAW steps that turned out payable: the
// 53 km that came with 89,339 raw steps is not evidence of anything once
// 2,119 of those steps are all that were walked. Rows written since
// utils/stepMetrics.js are already held to their stored steps when saved, so
// the raw share scales them a little further than it needs to — the side to
// err on, for a day that failed verification.

const {
  trackClientCadence,
  resolveDayHold,
  validateSteps,
  selectPriorStuckSamples,
  readSamples,
  STUCK_RATE_TOLERANCE,
} = require('./stepValidation');

/** Challenge criteria whose value comes from the step pipeline. */
const FITNESS_CRITERIA = new Set(['STEPS', 'DISTANCE', 'CALORIES', 'ACTIVE_MINUTES']);

/** Sources paid for a range of steps. */
const PASSIVE_SOURCES = new Set(['PASSIVE_STEPS', 'PASSIVE_STEPS_RETRO']);

/** Sources paid for meeting the daily step goal. */
const GOAL_SOURCES = new Set([
  'DAILY_STEP_GOAL',
  'DAILY_STEP_GOAL_AUTO',
  'DAILY_STEP_GOAL_RETRO',
]);

/** Whether step coins wait for settlement instead of being paid live. */
function isStepCoinSettlementEnabled(cfg) {
  return cfg?.features?.stepCoinSettlement === true;
}

/** Whether a challenge's coins depend on the step pipeline. */
function isFitnessChallenge(criteriaType) {
  return FITNESS_CRITERIA.has(criteriaType);
}

const round4 = v => parseFloat((Number(v) || 0).toFixed(4));
const whole = v => Math.max(0, Math.round(Number(v) || 0));

/** A row's per-stream cadence states, from a hydrated Map or a lean object. */
function streamsOf(row) {
  const map = row?.cadenceBySource;
  if (!map) return [];
  return typeof map.entries === 'function' ? [...map.entries()] : Object.entries(map);
}

/**
 * The samples a day's hindsight replay treats as already known.
 *
 * From every stream the live rule refused at all: the refused samples, and
 * every other sample the stream produced at the same rate (inside
 * STUCK_RATE_TOLERANCE of one it refused) or of the same exact delta — which
 * is the evidence the live rule gathered before its first refusal, and was
 * paid for.
 *
 * @param {object} row - The day's HealthActivity row.
 * @returns {Array<{delta: number, rate: number|null, from: number|null, at: number}>}
 */
function dayPattern(row) {
  const spread = (a, b) => (a + b > 0 ? Math.abs(a - b) / ((a + b) / 2) : 0);
  const pattern = [];
  for (const [, state] of streamsOf(row)) {
    const samples = readSamples(state?.samples);
    const refused = samples.filter(s => s.stuck);
    if (!refused.length) continue;
    const deltas = new Set(refused.map(s => s.delta));
    const rates = refused.map(s => s.rate).filter(r => r != null && r > 0);
    for (const s of samples) {
      const sameRate =
        s.rate != null && s.rate > 0 && rates.some(r => spread(r, s.rate) <= STUCK_RATE_TOLERANCE);
      if (s.stuck || sameRate || deltas.has(s.delta)) {
        pattern.push({ delta: s.delta, rate: s.rate, from: s.from, at: s.at });
      }
    }
  }
  return pattern;
}

/**
 * The day's samples replayed through the live rules, with the day's pattern
 * known from the start.
 *
 * Built from the per-stream samples on the row — each stream's first sample
 * also gives the figure it was measured from, which stands in for that
 * stream's opening sync. Syncs too small to be samples are not on the row and
 * are not replayed; on the days this is used for, they are noise.
 *
 * Pure. The date being replayed is always in the past, so every clock-bound
 * ceiling sees its whole day.
 *
 * @param {object} row - The day's HealthActivity row, lean or hydrated.
 * @param {Array} [pattern] - The samples to treat as known; defaults to
 *   dayPattern(row).
 * @param {object} [options]
 * @param {boolean} [options.closeOnReturn] - Whether the first return to the
 *   pattern closes the day, as a carried pattern does live. Defaults to
 *   whether the day's own pattern ran long enough to be carried.
 * @returns {number} Walked steps the replay stores.
 */
function replayDayWithHindsight(
  row,
  pattern = dayPattern(row),
  { closeOnReturn = selectPriorStuckSamples([row]).length > 0 } = {},
) {
  const syncs = [];
  for (const [source, state] of streamsOf(row)) {
    const samples = readSamples(state?.samples)
      .filter(s => s.total != null)
      .sort((a, b) => a.at - b.at);
    if (!samples.length) continue;
    const first = samples[0];
    if (first.from != null) {
      syncs.push({ at: first.from, raw: Math.max(0, first.total - first.delta), source });
    }
    for (const s of samples) syncs.push({ at: s.at, raw: s.total, source });
  }
  syncs.sort((a, b) => a.at - b.at);

  const prior = [...pattern, ...readSamples(row?.priorStuckSamples)];
  let stored = 0;
  let streams = {};
  let held = { by: null, since: null, forfeit: 0, closed: false };

  for (const { at, raw, source } of syncs) {
    const cadence = trackClientCadence({
      incomingSteps: raw,
      at,
      ...(streams[source] || {}),
      priorSamples: prior,
    });
    const hold = resolveDayHold({
      source,
      // Without closing, a known pattern is held where it appears and released
      // by the first sample that varies, like any other hold.
      cadence: closeOnReturn ? cadence : { ...cadence, recurrent: false },
      streams,
      heldBy: held.by,
      heldSince: held.since,
      forfeit: held.forfeit,
      closed: held.closed,
      existingWalked: stored,
      at,
    });
    const result = validateSteps({
      incomingSteps: Math.max(0, raw - hold.stuckForfeit),
      existingSteps: stored,
      bonusSteps: 0,
      syncDate: row.date,
      dailyGoal: 10_000,
      stepBaseline: row.stepBaseline ?? null,
      cadence: { ...cadence, stuck: hold.stuck, stuckReason: hold.stuckReason },
    });
    if (result.clampedSteps > stored) stored = result.clampedSteps;

    const { delta, rate, stuck, stuckReason, sample, recurrent, ...persisted } = cadence;
    streams = { ...streams, [source]: persisted };
    held = {
      by: hold.stuckSource,
      since: hold.stuckSince,
      forfeit: hold.stuckForfeit,
      closed: hold.closed,
    };
  }

  return stored;
}

/**
 * How much of a finished day's walking can be paid for.
 *
 * @param {object|null} row - The day's HealthActivity row, or null if none.
 * @param {string} [date] - The date, for a day with no row.
 * @returns {{ date: string, walked: number, bonus: number, payableWalked: number,
 *   ratio: number, distance: number, calories: number, activeMinutes: number,
 *   status: 'verified'|'partial'|'refused'|'missing', reason: string|null }}
 *   `ratio` is what distance, calories and active minutes are scaled by: 1 on a
 *   verified day, the payable share of the day's raw steps otherwise.
 */
function verifyDay(row, date = row?.date) {
  if (!row) {
    return {
      date,
      walked: 0,
      bonus: 0,
      payableWalked: 0,
      ratio: 0,
      distance: 0,
      calories: 0,
      activeMinutes: 0,
      status: 'missing',
      reason: 'no activity was recorded for this day',
    };
  }

  const bonus = whole(row.bonusSteps);
  const walked = Math.max(0, whole(row.steps) - bonus);
  const base = {
    date,
    walked,
    bonus,
    distance: Math.max(0, Number(row.distance) || 0),
    calories: Math.max(0, Number(row.calories) || 0),
    activeMinutes: Math.max(0, Number(row.activeMinutes) || 0),
  };

  if (row.sharedHeld) {
    return {
      ...base,
      payableWalked: 0,
      ratio: 0,
      status: 'refused',
      reason: 'this step counter was also feeding another account, which was paid for it',
    };
  }

  const pattern = dayPattern(row);
  if (!pattern.length) {
    return { ...base, payableWalked: walked, ratio: 1, status: 'verified', reason: null };
  }

  const payableWalked = Math.min(walked, replayDayWithHindsight(row, pattern));
  if (payableWalked >= walked) {
    return { ...base, payableWalked: walked, ratio: 1, status: 'verified', reason: null };
  }

  // The client's raw figures, not the stored one: distance and calories were
  // reported against what the phone counted, which a hold does not reduce.
  const rawTotals = streamsOf(row).flatMap(([, st]) =>
    readSamples(st?.samples).map(s => s.total || 0),
  );
  const maxRaw = Math.max(walked, whole(row.lastIncomingSteps), ...rawTotals);

  return {
    ...base,
    payableWalked,
    ratio: maxRaw > 0 ? payableWalked / maxRaw : 0,
    status: payableWalked > 0 ? 'partial' : 'refused',
    reason:
      'the phone reported a steady, machine-like step rate; only ' +
      `${payableWalked.toLocaleString('en-IN')} of the day's ` +
      `${walked.toLocaleString('en-IN')} steps could be verified`,
  };
}

/** Every date from `start` to `end` inclusive, "YYYY-MM-DD". Bounded to a week. */
function datesThrough(start, end) {
  const out = [];
  const [y, m, d] = String(start).split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(cursor.getTime())) return [end];
  while (out.length < 8) {
    const iso = cursor.toISOString().slice(0, 10);
    if (iso > end) break;
    out.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out.length ? out : [end];
}

/** A day's payable value for one challenge criterion. */
function metricOf(verdict, criteriaType) {
  switch (criteriaType) {
    case 'STEPS':          return verdict.payableWalked + verdict.bonus;
    case 'DISTANCE':       return verdict.distance * verdict.ratio;
    case 'CALORIES':       return verdict.calories * verdict.ratio;
    case 'ACTIVE_MINUTES': return verdict.activeMinutes * verdict.ratio;
    default:               return 0;
  }
}

/**
 * How much of one pending award to pay.
 *
 * Pure. `verdictFor` returns verifyDay()'s answer for a date; a weekly
 * challenge asks it for every day of the week up to the day it completed.
 *
 * @param {{ date: string, source: string, amount: number, metadata?: object }} entry
 * @param {(date: string) => ReturnType<typeof verifyDay>} verdictFor
 * @returns {{ pay: number, reason: string|null }}
 */
function settlementFor(entry, verdictFor) {
  const amount = round4(entry.amount);
  const meta = entry.metadata || {};
  const verdict = verdictFor(entry.date);
  const full = { pay: amount, reason: null };
  const none = reason => ({ pay: 0, reason: reason || 'the day could not be verified' });

  if (PASSIVE_SOURCES.has(entry.source)) {
    if (verdict.status === 'verified') return full;
    // The award paid for the steps from `previousSteps` to `steps`. Whatever
    // part of that range lies under the payable total is paid, pro rata.
    const from = whole(meta.previousSteps);
    const to = whole(meta.steps);
    if (to <= verdict.payableWalked) return full;
    if (from >= verdict.payableWalked || to <= from) return none(verdict.reason);
    return {
      pay: round4((amount * (verdict.payableWalked - from)) / (to - from)),
      reason: verdict.reason,
    };
  }

  if (GOAL_SOURCES.has(entry.source)) {
    if (verdict.status === 'verified') return full;
    // The same default every award path falls back to when an account has no
    // goal of its own.
    const goal = whole(meta.goal) || 10_000;
    return verdict.payableWalked + verdict.bonus >= goal ? full : none(verdict.reason);
  }

  if (entry.source === 'CHALLENGE' && isFitnessChallenge(meta.criteriaType)) {
    const dates =
      meta.challengeType === 'weekly'
        ? datesThrough(meta.weekStart || entry.date, entry.date)
        : [entry.date];
    const verdicts = dates.map(verdictFor);
    // A day with no row adds nothing to a week, exactly as it did live.
    if (verdicts.every(v => v.status === 'verified' || v.status === 'missing')) {
      if (meta.challengeType === 'weekly' || verdict.status === 'verified') return full;
    }
    const value = verdicts.reduce((sum, v) => sum + metricOf(v, meta.criteriaType), 0);
    const reason = verdicts.find(v => v.status !== 'verified')?.reason;
    return value >= (Number(meta.targetValue) || 0) ? full : none(reason);
  }

  // Nothing else is ever recorded as pending; if something is, pay it.
  return full;
}

module.exports = {
  FITNESS_CRITERIA,
  PASSIVE_SOURCES,
  GOAL_SOURCES,
  isStepCoinSettlementEnabled,
  isFitnessChallenge,
  dayPattern,
  replayDayWithHindsight,
  verifyDay,
  settlementFor,
  datesThrough,
};
