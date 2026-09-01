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
//   3. Rate ceiling — the LOOSER of two sufficient bounds, because a figure is
//      only implausible when neither can explain it:
//        a. the DELTA since steps were last accepted, for a device reporting
//           live as the user moves; and
//        b. the TOTAL against how much of its day has elapsed, for a source
//           that reports the day cumulatively from local midnight — which is
//           what every reader in this system actually does.
//      See the long note at the ceiling itself for why choosing between them
//      instead of taking the looser one punished the diligent device.
//   4. No-decrease rule (handled separately, after the ceilings): steps should
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
const MAX_STEPS_PER_HOUR = 12_000; // ~200 steps/min sustained (running)
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

/**
 * Follows the client's OWN step deltas across syncs, so a source that has stopped
 * measuring can be recognised.
 *
 * Pure, and separate from validateSteps, because it is bookkeeping the caller has
 * to persist between requests rather than a judgement about this one. The caller
 * stores the returned `lastIncomingSteps`/`lastIncomingDelta`/`repeatedDeltaCount`
 * on the day's row and hands them back on the next sync.
 *
 * Multi-device accounts fail OPEN: two phones posting their own totals produce
 * deltas that do not match each other, the streak resets, and the rule never
 * binds. That is the right direction to fail for a rule whose effect is to stop
 * counting a user's steps.
 *
 * @param {object} params
 * @param {number} params.incomingSteps - Raw client total for the day, before any clamping.
 * @param {number|null} params.lastIncomingSteps - Raw client total from the previous sync.
 * @param {number} params.lastIncomingDelta - The delta that produced `repeatedDeltaCount`.
 * @param {number} params.repeatedDeltaCount - How many times that delta has now repeated.
 * @returns {{ delta: number, lastIncomingSteps: number, lastIncomingDelta: number,
 *   repeatedDeltaCount: number, stuck: boolean }}
 */
function trackClientCadence({
  incomingSteps,
  lastIncomingSteps = null,
  lastIncomingDelta = 0,
  repeatedDeltaCount = 0,
}) {
  const incoming = Math.round(Number(incomingSteps) || 0);

  // No previous raw total to measure against — the first sync of a day, or a row
  // written by a build too old to have recorded one. Seed and say nothing.
  if (lastIncomingSteps === null || lastIncomingSteps === undefined) {
    return {
      delta: 0,
      lastIncomingSteps: incoming,
      lastIncomingDelta: 0,
      repeatedDeltaCount: 0,
      stuck: false,
    };
  }

  const delta = incoming - Math.round(Number(lastIncomingSteps) || 0);

  // A re-send of the same count, or a lower figure from a device that is behind.
  // Neither says anything about cadence, and neither should keep a streak alive.
  if (delta < STUCK_DELTA_MIN_STEPS) {
    return {
      delta,
      lastIncomingSteps: incoming,
      lastIncomingDelta: delta,
      repeatedDeltaCount: 0,
      stuck: false,
    };
  }

  const repeated = delta === lastIncomingDelta ? repeatedDeltaCount + 1 : 0;

  return {
    delta,
    lastIncomingSteps: incoming,
    lastIncomingDelta: delta,
    repeatedDeltaCount: repeated,
    stuck: repeated >= STUCK_DELTA_REPEATS,
  };
}

/**
 * Validates incoming step count and returns a safe value.
 *
 * @param {object} params
 * @param {number|null|undefined} params.incomingSteps - Raw step count from client
 * @param {number} params.existingSteps - Previously stored step count for today
 * @param {number} params.bonusSteps - Bonus steps (admin-credited, not from device)
 * @param {Date|null} [params.lastStepIncreaseAt] - When this day's step count was
 *   last actually accepted upward. This, not the document's updatedAt, defines the
 *   rate window — see the note in the body.
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
  lastStepIncreaseAt = null,
  timezone = null,
  syncDate = null,
  dailyGoal,
  allowCorrection = false,
  cadence = null,
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
      reason:
        `Source not measuring: +${cadence.delta} steps reported ` +
        `${cadence.repeatedDeltaCount + 1} times in a row, identical to the step ` +
        `across differently-sized sync windows`,
    });
  }

  // ── The two rate ceilings, and why the LOOSER one wins ────────────────────
  //
  // There are two honest ways to bound how fast steps may arrive, and they
  // describe two different SHAPES of arrival:
  //
  //   * The delta ceiling asks "could these steps have been walked since we last
  //     accepted any?" — right for a device reporting live as the user moves.
  //   * The day ceiling asks "is this total plausible for how much of the day has
  //     elapsed?" — right for a source that reports the day CUMULATIVELY from
  //     local midnight, which is what every reader in this system actually does.
  //
  // These used to be alternatives: the delta ceiling whenever a previous increase
  // existed, the day ceiling only for the first accepted value of a day. Combining
  // them with `Math.min` was tried before that and was worse — the delta bound,
  // measured from local midnight as a stand-in, undercut the day bound and cut a
  // legitimate 2,500-step report five minutes into the day down to 1,100.
  //
  // But choosing between them by "has anything been accepted yet" produced a
  // backwards result, and a real account shows it. Health Connect reports the day
  // from midnight, so when this user's app finally read it at 20:51 local, it
  // carried a 4,793-step correction covering a morning the phone's own sensor had
  // missed — 192 timestamped records, an entirely ordinary day's walking. The
  // delta ceiling saw "4,793 steps since the last sync" and rationed it out at 220
  // a minute across seven consecutive clamped syncs, taking 46 minutes to arrive
  // at a figure it would have accepted instantly from a device that had simply
  // stayed quiet until then. Same user, same day, same steps, same evidence — and
  // the only thing separating "accept it all now" from "wait 46 minutes" was
  // whether the phone had been diligent enough to sync earlier.
  //
  // Taking the LOOSER of the two removes that asymmetry. A figure is accepted if
  // EITHER story could explain it, which is the correct reading of two independent
  // sufficient bounds: a value is only implausible when NEITHER holds. Both are
  // still computed entirely from the server clock, the user's timezone and the
  // stored total — nothing here trusts a number the client supplied about itself,
  // so this cannot be steered by a lying device.
  //
  // What still binds: MAX_DAILY_STEPS above, the stuck-source rule above, and the
  // day ceiling itself, which stays below the daily cap for the first 22 hours of
  // every day and reaches it only when a whole day genuinely has elapsed.
  const rateCeilings = [];

  if (lastStepIncreaseAt) {
    // ── Delta ceiling ───────────────────────────────────────────────────────
    // The window is the time since steps were last ACCEPTED upward, not since the
    // row was last written.
    //
    // It used to be `updatedAt`, which any write to the row bumps — including a
    // hydration-only sync, which posts to this same endpoint with no steps at all.
    // So a user could log a glass of water and, thirty seconds later, have a
    // legitimate sync carrying three hours of real walking judged as an impossible
    // burst against a thirty-second window. Measuring from the last accepted
    // increase makes the window mean what the rule needs it to mean, and it removes
    // the incentive to sync rapidly: syncing more often no longer resets the window
    // unless steps were actually accepted, and if they were, the elapsed time is
    // genuinely small so the allowance is genuinely small.
    const windowMinutes = Math.max(
      0,
      (Date.now() - new Date(lastStepIncreaseAt).getTime()) / 60_000,
    );

    // Burst allowance for short windows, sustained rate for long ones — the same
    // split the previous two rate checks intended.
    const maxDelta =
      windowMinutes < 60
        ? Math.ceil(windowMinutes * MAX_STEPS_PER_MINUTE)
        : Math.ceil((windowMinutes / 60) * MAX_STEPS_PER_HOUR);

    rateCeilings.push({
      limit: existingWalked + maxDelta,
      reason:
        `Rate too high: +${steps - existingWalked} steps in ` +
        `${
          windowMinutes < 60
            ? `${Math.round(windowMinutes)} min`
            : `${(windowMinutes / 60).toFixed(1)} hrs`
        } ` +
        `(max ${maxDelta})`,
    });
  }

  if (steps > 0) {
    // ── Day ceiling ─────────────────────────────────────────────────────────
    // The reported total has to stand on its own plausibility for the time of
    // day. Held to a sustained rate rather than the burst rate, with a floor so
    // the first minutes of the day are not unusably tight.
    //
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
    rateCeilings.push({
      limit: Math.max(existingWalked, maxForDay),
      reason:
        `Total too high for the day: ${steps} steps in ` +
        `${hoursOnDate.toFixed(1)}h ` +
        `(${isWholeDay ? 'the full day' : 'since local midnight'}) ` +
        `(max plausible: ${maxForDay})`,
    });
  }

  // The looser of the two, and its reason, so what gets reported is the bound
  // that actually held rather than the one that happened to be listed first.
  if (rateCeilings.length) {
    ceilings.push(rateCeilings.reduce((a, b) => (b.limit > a.limit ? b : a)));
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
  MAX_DAILY_STEPS,
  STUCK_DELTA_MIN_STEPS,
  STUCK_DELTA_REPEATS,
};
