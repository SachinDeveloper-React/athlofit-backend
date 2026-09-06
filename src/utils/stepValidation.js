// src/utils/stepValidation.js
//
// Server-side step validation / anti-cheat.
//
// Validates incoming step counts against physiological limits and
// rate-of-change rules. Returns the clamped (safe) step count and
// flags suspicious submissions.
//
// How it works:
//   Every rule contributes a CEILING, and the accepted value is the minimum of
//   them. That structure is deliberate — see the note on the old design below.
//
//   1. Absolute daily cap.
//   2. Stuck-source rule: a device reporting a constant rather than a
//      measurement is held where it is.
//   3. Day ceiling: the total against how much of its day has elapsed. A hard
//      bound — no story about backlogs or sync cadence makes more steps fit into
//      a day than the day has room for. There used to be a second, DELTA-based
//      rate ceiling here and the looser of the two won; that let a client syncing
//      every 15 minutes collect 220 steps/min all day. See the long note at the
//      ceiling itself.
//   4. Baseline ceiling: what THIS account walks, from its own trailing days.
//      The only rule here that is about the user rather than about the species,
//      and the one the step-spoofing incident needed. See the note at
//      BASELINE_FLOOR.
//   5. No-decrease rule (handled separately, after the ceilings): steps should
//      not decrease within a day, allowing a small tolerance for sensor jitter.
//      Overridable via `allowCorrection` so a client that over-reported can
//      repair the record.
//
// ── Why the ceilings are composed with Math.min ──────────────────────────────
//
// The previous version applied each rule by ASSIGNING to `steps`, so the last
// rule to run decided the value. That turned the rapid-jump rule into a step
// GRANT rather than a cap:
//
//     if (elapsedMs < 5min && stepDelta > 5000) steps = existingWalked + 5000;
//
// A client reporting a figure far above the stored one was not rejected — it was
// handed exactly `existing + 5000`. It then reported the same figure again, and
// got another 5000 on top. The stored total climbed in exact 5,000-step
// increments, indefinitely, which is the "steps jumping by 5000 continuously"
// report this replaces.
//
// Two things made it worse:
//   * The rule computed `stepDelta` from the ORIGINAL input, then overwrote the
//     much tighter value the rate rule had just produced. So it actively undid
//     the rate limit (a 3-minute window allows 660 steps; this raised it to 5000).
//   * A 2-minute minimum on the rate check meant syncs closer together than that
//     skipped the rate rule entirely. The app's foreground sync throttle is 20
//     seconds, so the grant applied every 20 seconds with no rate check at all.
//
// Note that 5,000 steps in under 5 minutes needs >1,000 steps/min, while this
// file's own MAX_STEPS_PER_MINUTE is 220 — the threshold was looser than the
// rate limit for every window under ~22 minutes, so it could only ever add
// steps, never restrict them. It is gone; the rate ceiling covers the same
// attack correctly, at every window size.

const { minutesElapsedOnDate } = require('./date');

const MAX_DAILY_STEPS = 50_000; // realistic daily cap (marathon = ~42k steps)
const MAX_STEPS_PER_MINUTE = 220; // absolute burst (sprinting)
const DECREASE_TOLERANCE = 100; // allow small sensor corrections

// ── The day ceiling's intercept at midnight ─────────────────────────────────
//
// (This bound was once the "first accepted value of the day" ceiling and applied
// only to a day's first sync. It now applies to every sync, as the second of the
// two rate bounds — see the note at the ceiling. The reasoning below is what set
// its shape, and is unchanged by that.)
//
// This bound used to be `max(3_000, hours * 9_000)` — a sustained 150 steps/min
// for however much of the day had elapsed. That is a rate no human holds for a
// whole day, and the arithmetic made it worse: 50,000 / 9,000 is 5.6 hours, so
// from mid-morning onward the bound exceeded MAX_DAILY_STEPS and stopped binding
// altogether. From 05:36 until midnight the ONLY limit on the first sync of a day
// was the absolute daily cap, so a client could hand over 50,000 steps in a single
// post and be paid passive coins for all of them without the rule ever engaging.
// That is the "0 → 26,872 in one transaction" row in the coin ledger.
//
// The replacement interpolates between two figures the system already commits to:
// what could plausibly arrive at any single moment, and what a whole day may hold.
//
//   * At 00:00 the bound is FIRST_SYNC_BURST_ALLOWANCE. An intercept is needed
//     because the client and server do not agree on the day boundary to the
//     minute — timezone strings, clock skew and a device that just crossed
//     midnight all put real steps in the first minutes of a "day" — and because
//     an early-morning run is genuinely front-loaded.
//   * At 24:00 the bound is exactly MAX_DAILY_STEPS, so a past date whose whole
//     day happened is judged by the daily cap and nothing tighter. (Exactly, not
//     approximately: the ceilings are combined with a strict `<`, so a tie leaves
//     the daily cap as the binding rule and its reason as the one reported.)
//
// In between it is linear, which keeps it BELOW the daily cap for the first 22
// hours of every day — so unlike the old version it actually does something for
// the whole day rather than expiring before lunch.
const FIRST_SYNC_BURST_ALLOWANCE = 6_000;

// ── A source that has stopped measuring ─────────────────────────────────────
//
// Every ceiling above bounds how FAST steps may arrive. None of them can tell
// whether the number arriving is a measurement at all, and that is a real gap:
// a device whose counter is being advanced by a fixed quantum each sync sits
// comfortably under the rate ceiling forever. One account reported 2,270 steps
// in each of eight consecutive 15-minute syncs — 18,160 steps — and every one
// of them was accepted, because 2,270 is well below the 3,311 a 15-minute
// window allows.
//
// What gave it away was not the size of the deltas but their INVARIANCE. The
// sync windows in that run ranged from 15.02 to 15.09 minutes; at the implied
// 150.8 steps/min a real counter would have varied by roughly ±11 steps across
// them. It varied by zero. A figure derived from a hardware counter cannot be
// independent of how much time elapsed, so a delta that repeats to the exact
// step across differently-sized windows is not a measurement — it is a constant
// being added.
//
// Hence a rule about repetition rather than magnitude. It is deliberately
// measured on the RAW client total, not on the stored one: once this rule binds,
// the stored total stops moving, so a server-side delta would start growing
// (2,270, 4,540, 6,810…) and the pattern would break on the very next sync,
// releasing the guard it just triggered.
//
// Both thresholds are set so that no real device trips them:
//   * 500 steps, because small identical deltas are ordinary — a phone idling on
//     a desk reports +10 twice in a row all the time, and that is not evidence.
//   * three repeats, so the fourth identical delta is the first one refused. Two
//     matching deltas is a coincidence a brisk, steady walker could produce; four
//     identical to the step is not something a counter does.
const STUCK_DELTA_MIN_STEPS = 500;
const STUCK_DELTA_REPEATS = 3;

// ── The same fault, one jitter away ─────────────────────────────────────────
//
// The rule above tests deltas for EXACT equality, and that turned out to be a
// threshold an attacker steps over by adding noise. The account that prompted
// it was later seen posting 2,240 / 2,310 / 2,280 / 2,260 / 2,280 — a spread of
// roughly ±1.5% — and the streak never got past two, because the fourth
// identical delta it waits for never arrived. Nineteen consecutive syncs were
// accepted and the day closed at the daily cap.
//
// The original reasoning was right and the test was too literal. What it says is
// that a figure derived from a hardware counter cannot be independent of how much
// time elapsed. Equality of DELTAS is one way to see that; equality of RATES is
// the general form, and it survives jitter.
//
// So this measures steps per minute across each sync window and asks whether the
// spread of the streak stays inside a narrow band:
//
//     (max rate - min rate) / midpoint <= STUCK_RATE_TOLERANCE
//
// Spread rather than distance from a reference, because a reference has to be
// picked and both available choices are wrong. Fixing it to the first sample
// makes the verdict depend on which sample happened to start the run — the same
// incident data trips the rule or does not, at ±3%, depending on whether the
// streak begins at 11:44 or 11:59. Updating it to a running mean lets a slowly
// drifting rate stay "in band" indefinitely by walking the reference along with
// it. Min and max over the streak have neither problem and are order-independent.
//
// ── Why a span and not just a count ─────────────────────────────────────────
//
// Sample count alone is not a unit that means anything here, because sync cadence
// is the client's choice. Six samples from the widget worker is an hour and a
// half; six from the app's foreground sync can be twelve minutes, which is an
// ordinary steady walk. Requiring a wall-clock span as well makes the rule say
// what it means — the rate has not varied for an hour and a half — at any cadence.
//
// The thresholds are set so that being wrong is survivable rather than so that
// it is impossible. Ninety minutes of walking whose 15-minute rates stay within
// 5% is something a treadmill could produce; a road crossing, a traffic light or
// sitting down for a minute breaks it, which is why real outdoor walking does
// not. And the consequence of a false positive is 'stuck_source', which holds
// the total and explicitly never reaches the cheat path — then releases on the
// first sample that varies.
/** Fractional spread of steps/min a streak may hold before it is not a measurement. */
const STUCK_RATE_TOLERANCE = 0.05;
/** Consecutive in-band samples needed. */
const STUCK_RATE_SAMPLES = 6;
/** Wall-clock minutes the streak must also span, so cadence cannot shortcut it. */
const STUCK_RATE_MIN_SPAN_MIN = 90;
/**
 * Shortest window a rate may be computed from. Below this the divisor is small
 * enough that ordinary timing noise dominates, and a burst of rapid syncs would
 * produce wild rates that break streaks rather than reveal anything.
 */
const STUCK_RATE_MIN_WINDOW_MIN = 2;

// ── What THIS user walks, as opposed to what a human can walk ───────────────
//
// Every rule above this point asks the same question: "could a person have
// walked this?" None of them asks "could this person have walked this?", and
// that gap is what the step-spoofing incident actually exploited.
//
// The evidence. Thirteen accounts carried Health Connect origins with a
// randomised package suffix. Ten of them had ONE such origin, stable for weeks,
// and their days ran 43 to 13,830 steps — ordinary people, and the randomised
// suffix is just how the platform pedometer names itself. The other three
// rotated between four and nine origins, one of them five in a single day, and
// their days ran 15,488 to 50,000 with a mean of 31,048. One account posted six
// consecutive days averaging 34,682 — 26 km every day for a week.
//
// Not one of those days was refused. Every one of them was under MAX_DAILY_STEPS,
// and MAX_DAILY_STEPS is the only bound that spans a whole day. That constant is
// a backstop against the physically impossible, not a statement about anybody in
// particular: 50,000 steps is a marathon and a half. Against a population whose
// honest maximum is 13,830 it leaves a 3.6x corridor that is invisible to
// validation, and the corridor is where all of the fraud lived.
//
// So the ceiling has to know the user. The shape:
//
//   limit = clamp(BASELINE_FLOOR, MULTIPLIER * p90(trailing days), MAX_BASELINE)
//
// p90 rather than the mean, because the ceiling should be set by a good day and
// not dragged down by a quiet week. The multiplier is what keeps it a ceiling
// rather than a target — it has to sit far enough above normal that improving,
// travelling, or walking a half marathon does not hit it.
//
// Three properties this is built for:
//
//   * It cannot be jumped. A new account gets BASELINE_FLOOR and nothing more,
//     so day one is 15,000 and no argument about elapsed hours changes that.
//   * It can only be climbed slowly. The trailing window is fed by figures this
//     rule already accepted, so the ceiling at most multiplies once per window —
//     and a user pinned to their own ceiling every single day is a pattern that
//     reads clearly in the data, which the old corridor never produced.
//   * It has a hard roof. MAX_BASELINE_CEILING binds however good the history
//     looks, so a history that was poisoned before this rule existed cannot
//     unlock the full daily cap while it is being cleaned up.
//
// Being over it is 'clamped', never 'implausible'. The figure is possible for a
// human and this rule is a statement about a distribution, not about intent —
// a genuine ultramarathon gets clamped here and must not be punished for it.
/** Ceiling for an account with too little history to characterise. */
const BASELINE_FLOOR = 15_000;
/** How far above a user's own good day the ceiling sits. */
const BASELINE_MULTIPLIER = 1.75;
/** Hard roof, whatever the history says. */
const MAX_BASELINE_CEILING = 30_000;
/** Days of history below which only the floor applies. */
const BASELINE_MIN_DAYS = 7;
/** Trailing days the baseline is computed over. */
const BASELINE_WINDOW_DAYS = 28;

/**
 * The per-user daily ceiling, from that user's own recent days.
 *
 * Pure, and takes already-loaded totals rather than querying, so the policy is
 * testable without a database and the caller decides how the window is read.
 *
 * @param {number[]} recentDailyWalked - Walked steps (bonus excluded) for the
 *   trailing days, EXCLUDING the day being validated. Order does not matter.
 * @returns {number} The ceiling to apply.
 */
function computeStepBaseline(recentDailyWalked) {
  const days = (Array.isArray(recentDailyWalked) ? recentDailyWalked : [])
    .map(n => Number(n))
    .filter(n => Number.isFinite(n) && n >= 0);

  // Too new, or too sparse, to say anything about this account. The floor is the
  // whole rule for them — which is the right default: it is well above what any
  // honest user in the incident data reached, and well below the corridor.
  if (days.length < BASELINE_MIN_DAYS) return BASELINE_FLOOR;

  const sorted = [...days].sort((a, b) => a - b);
  // Nearest-rank p90: the smallest value at or above which the top decile sits.
  const p90 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];

  return Math.min(
    MAX_BASELINE_CEILING,
    Math.max(BASELINE_FLOOR, Math.ceil(p90 * BASELINE_MULTIPLIER)),
  );
}

/**
 * Follows the client's OWN step figures across syncs, so a source that has
 * stopped measuring can be recognised.
 *
 * Two independent detectors, either of which is sufficient:
 *
 *   * REPEATED DELTAS — the same delta to the exact step, several times running.
 *     Catches a counter being advanced by a fixed quantum regardless of how long
 *     the window was, which is the strongest possible evidence and needs no clock.
 *   * INVARIANT RATE — steps per minute holding inside a narrow band for an hour
 *     and a half. Catches the same fault once jitter has been added to defeat the
 *     equality test. See the note at STUCK_RATE_TOLERANCE.
 *
 * Kept as two rather than replaced by one, because they see different things: a
 * delta that repeats exactly across windows of DIFFERENT lengths has a constant
 * delta and a varying rate, so the rate test would miss it.
 *
 * Pure, and separate from validateSteps, because it is bookkeeping the caller has
 * to persist between requests rather than a judgement about this one. The caller
 * stores everything returned except `delta`, `rate`, `stuck` and `stuckReason` on
 * the day's row and hands it back on the next sync.
 *
 * Multi-device accounts fail OPEN: two phones posting their own totals produce
 * deltas that do not match each other and rates that jump around, so both streaks
 * reset and neither rule binds. That is the right direction to fail for a rule
 * whose effect is to stop counting a user's steps.
 *
 * @param {object} params
 * @param {number} params.incomingSteps - Raw client total for the day, before any clamping.
 * @param {number|Date} [params.at] - When this sync arrived. Defaults to now.
 * @param {number|null} params.lastIncomingSteps - Raw client total from the previous sync.
 * @param {number|Date|null} [params.lastIncomingAt] - When that total arrived.
 * @param {number} params.lastIncomingDelta - The delta that produced `repeatedDeltaCount`.
 * @param {number} params.repeatedDeltaCount - How many times that delta has now repeated.
 * @param {number} [params.cadenceStreak] - In-band rate samples so far.
 * @param {number|null} [params.cadenceRateMin] - Lowest rate in the current streak.
 * @param {number|null} [params.cadenceRateMax] - Highest rate in the current streak.
 * @param {number|Date|null} [params.cadenceStreakAt] - When the current streak began.
 * @returns {{ delta: number, rate: number|null, stuck: boolean, stuckReason: string|null,
 *   lastIncomingSteps: number, lastIncomingAt: number, lastIncomingDelta: number,
 *   repeatedDeltaCount: number, cadenceStreak: number, cadenceRateMin: number|null,
 *   cadenceRateMax: number|null, cadenceStreakAt: number|null }}
 */
function trackClientCadence({
  incomingSteps,
  at = Date.now(),
  lastIncomingSteps = null,
  lastIncomingAt = null,
  lastIncomingDelta = 0,
  repeatedDeltaCount = 0,
  cadenceStreak = 0,
  cadenceRateMin = null,
  cadenceRateMax = null,
  cadenceStreakAt = null,
}) {
  const ms = v => (v == null ? null : new Date(v).getTime());
  const incoming = Math.round(Number(incomingSteps) || 0);
  const now = ms(at) ?? Date.now();

  /** No streak of either kind. Used wherever the evidence has to start over. */
  const cleared = {
    lastIncomingSteps: incoming,
    lastIncomingAt: now,
    repeatedDeltaCount: 0,
    cadenceStreak: 0,
    cadenceRateMin: null,
    cadenceRateMax: null,
    cadenceStreakAt: null,
    stuck: false,
    stuckReason: null,
  };

  // No previous raw total to measure against — the first sync of a day, or a row
  // written by a build too old to have recorded one. Seed and say nothing.
  if (lastIncomingSteps === null || lastIncomingSteps === undefined) {
    return { ...cleared, delta: 0, rate: null, lastIncomingDelta: 0 };
  }

  const delta = incoming - Math.round(Number(lastIncomingSteps) || 0);

  // ── A re-send, or a device that is behind ────────────────────────────────
  // Nothing moved forward, so there is no evidence of any kind here and both
  // streaks genuinely start over. This is also what makes multi-device accounts
  // fail open: a second phone posting its own lower total lands here.
  if (delta <= 0) {
    return { ...cleared, delta, rate: null, lastIncomingDelta: delta };
  }

  // ── A gain too small to say anything ─────────────────────────────────────
  //
  // A phone idling on a desk reports +10 all day, and building a streak out of
  // that would freeze a real user's total over nothing.
  //
  // But it does not CLEAR a streak either, and that distinction matters. It used
  // to: any delta under the threshold reset both detectors, so a single small
  // sync released a hold outright. Replaying the real incident through this
  // showed exactly that — the run was held from 14:15, then a +119 sync at 16:31
  // cleared it and the total climbed again on the very next ceiling. One cheap
  // sync should not be able to buy back a rule that took ninety minutes of
  // evidence to trigger.
  //
  // So it is treated the way a too-short window is: not a sample. It neither
  // extends nor breaks anything, and only the markers move.
  if (delta < STUCK_DELTA_MIN_STEPS) {
    const spanSoFar =
      cadenceStreakAt == null ? 0 : (now - ms(cadenceStreakAt)) / 60_000;
    const heldStuck =
      repeatedDeltaCount >= STUCK_DELTA_REPEATS ||
      (cadenceStreak >= STUCK_RATE_SAMPLES && spanSoFar >= STUCK_RATE_MIN_SPAN_MIN);
    return {
      delta,
      rate: null,
      lastIncomingSteps: incoming,
      lastIncomingAt: now,
      lastIncomingDelta,
      repeatedDeltaCount,
      cadenceStreak,
      cadenceRateMin,
      cadenceRateMax,
      cadenceStreakAt: ms(cadenceStreakAt),
      stuck: heldStuck,
      stuckReason: heldStuck
        ? 'cadence streak still standing; this sync was too small to be evidence either way'
        : null,
    };
  }

  // ── Detector 1: the same delta, exactly ───────────────────────────────────
  const repeated = delta === lastIncomingDelta ? repeatedDeltaCount + 1 : 0;

  // ── Detector 2: a rate that does not vary ─────────────────────────────────
  const prevAt = ms(lastIncomingAt);
  const windowMinutes = prevAt == null ? null : (now - prevAt) / 60_000;

  let streak = cadenceStreak;
  let rateMin = cadenceRateMin;
  let rateMax = cadenceRateMax;
  let streakAt = ms(cadenceStreakAt);
  let rate = null;

  if (windowMinutes != null && windowMinutes >= STUCK_RATE_MIN_WINDOW_MIN) {
    rate = delta / windowMinutes;

    const nextMin = rateMin == null ? rate : Math.min(rateMin, rate);
    const nextMax = rateMax == null ? rate : Math.max(rateMax, rate);
    const midpoint = (nextMin + nextMax) / 2;
    const spread = midpoint > 0 ? (nextMax - nextMin) / midpoint : 0;

    if (streak > 0 && spread <= STUCK_RATE_TOLERANCE) {
      streak += 1;
      rateMin = nextMin;
      rateMax = nextMax;
    } else {
      // Out of band, or nothing to extend. Either way this sample starts the run.
      streak = 1;
      rateMin = rate;
      rateMax = rate;
      streakAt = prevAt; // the streak covers the window, so it starts where that did
    }
  }
  // Windows too short to measure are skipped rather than treated as evidence
  // either way: they neither extend a streak nor break one. A burst of rapid
  // syncs is a normal thing for the app to do and must not be able to clear a
  // streak on its own, nor to build one out of timing noise.

  const spanMinutes = streakAt == null ? 0 : (now - streakAt) / 60_000;
  const rateStuck =
    streak >= STUCK_RATE_SAMPLES && spanMinutes >= STUCK_RATE_MIN_SPAN_MIN;
  const deltaStuck = repeated >= STUCK_DELTA_REPEATS;

  let stuckReason = null;
  if (deltaStuck) {
    stuckReason =
      `+${delta} steps reported ${repeated + 1} times in a row, identical to ` +
      'the step across differently-sized sync windows';
  } else if (rateStuck) {
    stuckReason =
      `${rateMin.toFixed(1)}–${rateMax.toFixed(1)} steps/min held across ` +
      `${streak} syncs over ${Math.round(spanMinutes)} minutes — a spread of ` +
      `${((rateMax - rateMin) / ((rateMin + rateMax) / 2) * 100).toFixed(1)}%, ` +
      'which a counter measuring elapsed time does not produce';
  }

  return {
    delta,
    rate,
    lastIncomingSteps: incoming,
    lastIncomingAt: now,
    lastIncomingDelta: delta,
    repeatedDeltaCount: repeated,
    cadenceStreak: streak,
    cadenceRateMin: rateMin,
    cadenceRateMax: rateMax,
    cadenceStreakAt: streakAt,
    stuck: deltaStuck || rateStuck,
    stuckReason,
  };
}

/**
 * Validates incoming step count and returns a safe value.
 *
 * @param {object} params
 * @param {number|null|undefined} params.incomingSteps - Raw step count from client
 * @param {number} params.existingSteps - Previously stored step count for today
 * @param {number} params.bonusSteps - Bonus steps (admin-credited, not from device)
 * @param {string|null} [params.timezone] - Client timezone, used to bound the
 *   first accepted value of the day by how much of their local day has elapsed.
 * @param {string|null} [params.syncDate] - "YYYY-MM-DD" the row being written, which
 *   is not necessarily today: POST /health/sync takes an explicit `date` and the
 *   Android widget worker re-posts the last seven days every 15 minutes. A past
 *   date is bounded by the whole day, today by the minutes elapsed so far. Omit and
 *   it assumes today, which is the old behaviour.
 * @param {number} params.dailyGoal - User's daily step goal (for context only)
 * @param {boolean} [params.allowCorrection] - When true, a decrease below the stored
 *   value is accepted instead of being silently raised back up. The client sets this
 *   only when it has detected that its own previously reported figure was too high.
 * @param {object|null} [params.cadence] - Result of trackClientCadence() for this
 *   sync. When it reports `stuck`, the client's deltas have stopped varying with
 *   the time between syncs, so the total is held where it is.
 * @param {string|null} [params.reader] - Which reader the client says produced this
 *   figure. Only used to decide whether the live-sensor bound below applies.
 * @param {number|null} [params.sensorWindowMinutes] - Minutes of walking this
 *   figure may cover, for a reader that measures live. See the ceiling.
 * @param {number|null} [params.stepBaseline] - This user's own daily ceiling, from
 *   computeStepBaseline() over their trailing days. Omit and only the population
 *   bounds apply, which is the pre-baseline behaviour — so an older caller that
 *   does not supply it is weakened, not broken.
 *
 * @returns {{ clampedSteps: number, flagged: boolean,
 *   severity: 'none'|'clamped'|'implausible'|'stuck_source', reason: string|null,
 *   corrected: boolean, correctedFrom: number|null }}
 *   `severity` grades WHY it was clamped: 'clamped' is routine (over a window
 *   ceiling but physically possible), 'implausible' is beyond human capacity for
 *   the elapsed day, 'stuck_source' is a device reporting a constant rather than a
 *   measurement. Only 'implausible' is evidence of cheating — see the note in the
 *   body before punishing on it. 'stuck_source' in particular must never be
 *   punished: it is a broken sensor, and the user did nothing.
 */
function validateSteps({
  incomingSteps,
  existingSteps,
  bonusSteps,
  timezone = null,
  syncDate = null,
  dailyGoal,
  allowCorrection = false,
  cadence = null,
  stepBaseline = null,
  reader = null,
  sensorWindowMinutes = null,
}) {
  // If no steps provided or negative, return 0
  if (
    incomingSteps === undefined ||
    incomingSteps === null ||
    incomingSteps < 0
  ) {
    return {
      clampedSteps: 0,
      flagged: false,
      severity: 'none',
      reason: null,
      corrected: false,
      correctedFrom: null,
    };
  }

  let steps = Math.round(incomingSteps);
  const existingWalked = Math.max(0, existingSteps - bonusSteps);

  let flagged = false;
  let reason = null;
  // 'none' | 'clamped' | 'implausible' — see the severity note further down.
  let severity = 'none';

  // ── Build every ceiling, then take the smallest ─────────────────────────────
  // Collected as {limit, reason} so the reason reported is the one that actually
  // bound the value. Nothing here assigns to `steps`, which is what makes it
  // impossible for one rule to raise what another lowered.
  const ceilings = [
    {
      limit: MAX_DAILY_STEPS,
      reason: `Exceeded daily cap (${steps} > ${MAX_DAILY_STEPS})`,
    },
  ];

  // ── The source has stopped measuring ──────────────────────────────────────
  // Hold the total exactly where it is. Not a rate — there is no rate to allow,
  // because the number arriving is not a function of elapsed time. Pushed before
  // the rate ceilings so that on a tie (a zero-length window makes the rate
  // ceiling `existingWalked` too) this is the reason reported, since it is the
  // one that explains what is actually wrong with the device.
  //
  // Carries its own severity so the ceiling that binds decides how it is graded.
  // Without that, a stuck device whose reported total has drifted past the daily
  // cap would be graded 'implausible' and handed to recordCheatFlag — punishing
  // someone for a sensor fault. See the severity note further down.
  if (cadence?.stuck) {
    ceilings.push({
      limit: existingWalked,
      severity: 'stuck_source',
      // The detector that fired says why, since the two see different faults and
      // an investigation branches on which one it was.
      reason: `Source not measuring: ${cadence.stuckReason || 'cadence stopped varying with elapsed time'}`,
    });
  }

  // ── A live sensor cannot deliver a backlog ────────────────────────────────
  //
  // The delta ceiling was removed from this file because it punished a legitimate
  // Health Connect backlog: HC reports the day cumulatively, so a phone that
  // finally reads it in the evening carries hours of real walking in one sync, and
  // rationing that at 220 steps a minute took 46 minutes to accept a figure it
  // would have taken instantly from a device that had stayed quiet.
  //
  // That reasoning holds for Health Connect and does NOT hold for the hardware
  // sensor. The foreground service listens live, so the steps it reports were
  // walked inside the window it was listening for — there is no backlog for it to
  // deliver. A figure from that reader is therefore bounded by human cadence in a
  // way an HC figure is not, and the distinction is the one the old rule failed to
  // draw: it applied the bound to both, so removing it removed it from both.
  //
  // What this catches: one account gained 8,328 steps across a 30-minute window,
  // labelled `native_sensor`, at 276 steps a minute. A live sensor cannot produce
  // that. It came from seedDayFromHealthConnect folding a Health Connect total
  // into the service's own count once a day, which arrives wearing the sensor's
  // label — see the note in stepOriginTrust.js.
  //
  // The window is the caller's, and must already account for the service having
  // been killed: an OEM that stops the foreground service leaves TYPE_STEP_COUNTER
  // running in hardware, so the next sync genuinely covers the whole silent
  // period. Passing a window that ignores that would clamp honest users on exactly
  // the phones that kill background services hardest.
  //
  // A client that would rather not be bounded can simply claim `health_connect`,
  // so this is not a defence against a patched build. It is a defence against an
  // honest client reporting a figure under a label that does not fit it.
  // `null` is "the caller cannot say", NOT a zero-length window. Number(null) is
  // 0 and passes every finite check, so without the explicit null test a caller
  // that omitted the window would pin the total exactly where it stood — which is
  // how a missing field turns into a silent, total freeze on a real user's day.
  if (
    reader === 'native_sensor' &&
    sensorWindowMinutes !== null &&
    sensorWindowMinutes !== undefined &&
    Number.isFinite(Number(sensorWindowMinutes)) &&
    Number(sensorWindowMinutes) >= 0
  ) {
    const window = Number(sensorWindowMinutes);
    const maxDelta = Math.ceil(window * MAX_STEPS_PER_MINUTE);
    ceilings.push({
      limit: Math.max(existingWalked, existingWalked + maxDelta),
      reason:
        `Live sensor cannot have counted this: +${steps - existingWalked} steps ` +
        `across ${Math.round(window)} min of listening ` +
        `(max ${maxDelta} at ${MAX_STEPS_PER_MINUTE}/min)`,
    });
  }

  // ── The day ceiling, which now actually binds ─────────────────────────────
  //
  // There were two rate ceilings here and the LOOSER of them won:
  //
  //   * a DELTA ceiling — "could these steps have been walked since we last
  //     accepted any?", measured from lastStepIncreaseAt; and
  //   * this DAY ceiling — "is this total plausible for how much of the day has
  //     elapsed?", measured from local midnight.
  //
  // Taking the looser was meant to stop the delta ceiling punishing a device that
  // had been diligent about syncing: Health Connect reports the day cumulatively,
  // so a phone that finally read it at 20:51 carried a 4,793-step correction that
  // the delta ceiling rationed out at 220 a minute across seven clamped syncs.
  // That reasoning was right about the delta ceiling and wrong about what to do
  // with it.
  //
  // What it produced: the delta ceiling allows `existingWalked + windowMinutes *
  // 220` and, because the burst rate applies to any window under an hour, a client
  // syncing every 15 minutes is allowed 3,300 steps EVERY TIME. That is 220 steps
  // a minute sustained for as long as it cares to keep talking — 316,800 in a day,
  // bounded by nothing but MAX_DAILY_STEPS. And since the looser bound won, the
  // day ceiling never got to say otherwise.
  //
  // A real account walked exactly through it. From 11:44 to 16:31 local, nineteen
  // syncs 15 minutes apart, each carrying about 2,270 steps — a flat 149 to 153
  // steps per minute for four and three quarter hours, 69% of the delta allowance
  // and never once touching it. From 14:30 onward every single sync exceeded the
  // day ceiling, and every single one was admitted because the delta ceiling was
  // looser. The day closed at exactly 50,000.
  //
  // So the delta ceiling is gone rather than demoted. The two are not symmetric
  // and never were:
  //
  //   * The day ceiling is a NECESSARY bound. No story about backlogs, watches or
  //     sync cadence makes more steps fit into a day than the day has room for, so
  //     nothing should be able to override it. It is a hard ceiling now.
  //   * The delta ceiling was a SUFFICIENT refinement for one arrival shape, and
  //     min-ing it back in is exactly the backlog bug described above. With the day
  //     ceiling hard it also has almost nothing left to do: the only region where
  //     it was tighter is the first minutes of a day, which FIRST_SYNC_BURST_
  //     ALLOWANCE already covers deliberately.
  //
  // Dropping it fixes the 20:51 backlog case outright — 4,793 steps in the evening
  // sits far below the day ceiling and is now accepted in one go — and closes the
  // cadence exploit at every window size, which is what taking the looser bound
  // could not do.
  if (steps > 0) {
    // The elapsed time is that of `syncDate`, not of today. This used to call
    // minutesSinceLocalMidnight() directly, which always answers for TODAY, while
    // the value being judged could belong to any of the last seven days: the
    // Android widget worker re-posts that whole window every 15 minutes. So a
    // past-date sync landing at 00:10 was measured against ten minutes, and a
    // genuine 12,000-step day with no row yet was clamped to the midnight
    // allowance, flagged as a cheat, and paid retroactive coins on the clamped
    // figure. minutesElapsedOnDate() gives a past date its full 1,440 minutes, at
    // which point the absolute daily cap is what binds — which is correct, since a
    // whole day genuinely did happen.
    const minutesOnDate = minutesElapsedOnDate(syncDate, timezone);
    const hoursOnDate = minutesOnDate / 60;
    const isWholeDay = minutesOnDate >= 24 * 60;
    const dayFraction = Math.min(1, Math.max(0, hoursOnDate / 24));
    const maxForDay = Math.ceil(
      FIRST_SYNC_BURST_ALLOWANCE +
        (MAX_DAILY_STEPS - FIRST_SYNC_BURST_ALLOWANCE) * dayFraction,
    );
    // Floored at what is already stored. A ceiling that lands below the accepted
    // total would push `steps` down, and Rule 3 would then raise it straight back
    // — a flag on every sync for the rest of the day and no change to the figure.
    // Ceilings stop growth; they do not claw back.
    ceilings.push({
      limit: Math.max(existingWalked, maxForDay),
      reason:
        `Total too high for the day: ${steps} steps in ` +
        `${hoursOnDate.toFixed(1)}h ` +
        `(${isWholeDay ? 'the full day' : 'since local midnight'}) ` +
        `(max plausible: ${maxForDay})`,
    });
  }

  // ── What this user walks ──────────────────────────────────────────────────
  //
  // The only bound here that is about the account rather than about the species.
  // See the note at BASELINE_FLOOR for what it is for and why the population
  // bounds could not do it.
  //
  // Deliberately does NOT grade itself, unlike the stuck-source rule. Forcing
  // 'clamped' here looked right — a figure over this account's distribution is
  // still physically possible, and a genuine ultramarathon must not reach the
  // cheat path — but it also swallowed the cases that ARE cheating: once a user
  // has a baseline, it is the lowest ceiling, so it would bind on a client
  // posting 999,999 and grade that 'clamped' too.
  //
  // The default grading already draws exactly the right line. It asks whether the
  // figure beats physicalDayBound — the daily cap, or 220 steps/min for the whole
  // elapsed day — which the ultramarathon does not and the fabricated total does.
  // So leave the grading alone and let it answer.
  if (steps > 0 && Number.isFinite(Number(stepBaseline)) && Number(stepBaseline) > 0) {
    const baseline = Math.round(Number(stepBaseline));
    ceilings.push({
      limit: Math.max(existingWalked, baseline),
      reason:
        `Above this account's usual range: ${steps} steps against a ceiling of ` +
        `${baseline} from its own recent days`,
    });
  }

  // ── How suspicious is this, really? ────────────────────────────────────────
  //
  // `flagged` alone cannot answer that, and wiring a punishment to it was the
  // mistake this severity split exists to correct.
  //
  // Being clamped is ROUTINE. The rate ceiling bounds a value by the time since
  // steps were last accepted, which is often seconds, while a client's figure can
  // legitimately jump by thousands in one go: a paired smartwatch flushes its
  // backlog into Health Connect, or the app is reopened after the OS killed it.
  // The server then walks the stored total up at the maximum rate over the next
  // few minutes, flagging on EVERY sync until it converges. Simulated against this
  // file, an honest user whose watch dumps 3,000 steps is flagged on 40 of 40
  // syncs — indistinguishable from a client posting 999,999. At a 3-flags-per-day
  // block threshold, that user is penalised inside the first minute.
  //
  // What separates the two is not whether we clamped, but whether the reported
  // figure is possible AT ALL for the day it claims. The watch backlog is real
  // steps that were really walked, so it sits far below the day's physical
  // ceiling; 999,999 does not. So:
  //
  //   'clamped'     — over a window ceiling but physically possible for the day.
  //                   Expected during normal operation. Never punish this.
  //   'implausible' — beyond what any human could have walked in the elapsed day,
  //                   or over the absolute daily cap. No real sensor produces this.
  //   'stuck_source' — the device is reporting a constant, not a measurement. A
  //                   fault, not a choice, so it is graded separately precisely so
  //                   that it can never reach the cheat path: a stuck counter
  //                   eventually drifts past the daily cap, and grading it by
  //                   magnitude alone would flag the user for their phone's bug.
  //
  // The day bound uses minutesElapsedOnDate, so a past-date sync is judged against
  // its whole day rather than against however little of today has elapsed — the
  // same correction the first-accepted-value ceiling needed.
  const dayBoundMinutes = minutesElapsedOnDate(syncDate, timezone);
  const physicalDayBound = Math.min(
    MAX_DAILY_STEPS,
    Math.ceil(dayBoundMinutes * MAX_STEPS_PER_MINUTE),
  );

  const binding = ceilings.reduce((a, b) => (b.limit < a.limit ? b : a));
  if (steps > binding.limit) {
    flagged = true;
    reason = binding.reason;
    // A ceiling may grade itself. Only the stuck-source rule does, because it is
    // the one case where the magnitude of the figure says nothing about how it
    // should be judged — the fault is in the shape of the data, not its size.
    severity =
      binding.severity ?? (steps > physicalDayBound ? 'implausible' : 'clamped');
    steps = binding.limit;
  }

  // ── Rule 3: No unreasonable decrease, unless it is an explicit correction ───
  //
  // Within a day steps normally only go up, and several devices may report for the
  // same user, so a lower figure is usually just a device that is behind. Keeping
  // the higher value is the right default.
  //
  // But applied unconditionally it made a wrong value permanent. The stored count
  // became a high-water mark that nothing could bring down: an inflated figure
  // stayed for the rest of the day, was handed back to the app as its baseline on
  // the next login, and got re-reported from there. There was no path by which a
  // corrected client could repair the record.
  //
  // `allowCorrection` provides that path. The client sets it only when the value it
  // is sending is materially lower than what it itself last sent today, i.e. when
  // it has detected and fixed its own over-count.
  //
  // This is not a cheat vector: it can only ever LOWER the stored count. Coin
  // awards are driven by a separate high-water mark, so a decrease neither refunds
  // nor re-mints coins — it just stops the wrong number being displayed forever.
  let corrected = false;
  let correctedFrom = null;
  if (steps < existingWalked - DECREASE_TOLERANCE && existingWalked > 0) {
    if (allowCorrection) {
      corrected = true;
      correctedFrom = existingWalked;
      reason = `Client-requested correction: ${existingWalked} → ${steps}`;
    } else {
      steps = existingWalked;
    }
  }

  steps = Math.max(0, steps);

  return {
    clampedSteps: steps,
    flagged,
    severity,
    reason,
    corrected,
    correctedFrom,
  };
}

module.exports = {
  validateSteps,
  trackClientCadence,
  computeStepBaseline,
  MAX_DAILY_STEPS,
  MAX_STEPS_PER_MINUTE,
  STUCK_DELTA_MIN_STEPS,
  STUCK_DELTA_REPEATS,
  STUCK_RATE_TOLERANCE,
  STUCK_RATE_SAMPLES,
  STUCK_RATE_MIN_SPAN_MIN,
  STUCK_RATE_MIN_WINDOW_MIN,
  BASELINE_FLOOR,
  BASELINE_MULTIPLIER,
  MAX_BASELINE_CEILING,
  BASELINE_MIN_DAYS,
  BASELINE_WINDOW_DAYS,
};
