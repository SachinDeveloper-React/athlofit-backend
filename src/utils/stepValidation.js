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
//   2. Rate ceiling: existing walked steps plus what could physically have been
//      walked since steps were last accepted (or since local midnight, if none
//      have been yet today).
//   3. First-sync ceiling: a tighter sustained rate for the first accepted value
//      of the day, since there is no prior point to measure a delta from.
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

// First accepted value of the day: ~150 steps/min sustained. Tighter than the
// burst rate because there is no earlier accepted point to measure against.
const MAX_FIRST_SYNC_STEPS_PER_HOUR = 9_000;
// Floor so the very start of the day is not unusably tight (00:05 would allow 12).
const FIRST_SYNC_FLOOR = 3_000;

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
 *
 * @returns {{ clampedSteps: number, flagged: boolean,
 *   severity: 'none'|'clamped'|'implausible', reason: string|null,
 *   corrected: boolean, correctedFrom: number|null }}
 *   `severity` grades WHY it was clamped: 'clamped' is routine (over a window
 *   ceiling but physically possible), 'implausible' is beyond human capacity for
 *   the elapsed day. Only 'implausible' is evidence of cheating — see the note in
 *   the body before punishing on it.
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

  // Exactly ONE of the two rate ceilings applies, because they are two ways of
  // saying the same thing and mixing them makes them fight:
  //
  //   * With a known last-accepted point, bound the DELTA since that point.
  //   * Without one, there is no delta to measure, so bound the TOTAL by how much
  //     of the user's local day has elapsed.
  //
  // Applying both let the delta bound (measured from local midnight as a stand-in)
  // undercut the first-value floor, so a 2,500-step report five minutes into the
  // day was cut to 1,100 despite the floor existing precisely to allow it.
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

    ceilings.push({
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
  } else if (steps > 0) {
    // ── First-accepted-value ceiling ────────────────────────────────────────
    // No accepted point to measure from, so the reported total has to stand on
    // its own plausibility for the time of day. Held to a sustained rate rather
    // than the burst rate, with a floor so the first minutes of the day are not
    // unusably tight.
    //
    // This branch also covers rows written before lastStepIncreaseAt existed:
    // those have a real step count but no window, and falling back to a
    // midnight-based delta would have wrongly clamped their next legitimate
    // increase. Here they simply get the time-of-day bound until their first
    // accepted increase populates the field.
    //
    // The elapsed time is that of `syncDate`, not of today. This used to call
    // minutesSinceLocalMidnight() directly, which always answers for TODAY, while
    // the value being judged could belong to any of the last seven days: the
    // Android widget worker re-posts that whole window every 15 minutes. So a
    // past-date sync landing at 00:10 was measured against ten minutes, and a
    // genuine 12,000-step day with no row yet was clamped to the FIRST_SYNC_FLOOR
    // of 3,000, flagged as a cheat, and paid retroactive coins on the clamped
    // figure. minutesElapsedOnDate() gives a past date its full 1,440 minutes, at
    // which point the absolute daily cap is what binds — which is correct, since a
    // whole day genuinely did happen.
    const minutesOnDate = minutesElapsedOnDate(syncDate, timezone);
    const hoursOnDate = minutesOnDate / 60;
    const isWholeDay = minutesOnDate >= 24 * 60;
    const maxFirstSync = Math.max(
      FIRST_SYNC_FLOOR,
      Math.ceil(hoursOnDate * MAX_FIRST_SYNC_STEPS_PER_HOUR),
    );
    ceilings.push({
      limit: Math.max(existingWalked, maxFirstSync),
      reason:
        `First accepted value too high: ${steps} steps in ` +
        `${hoursOnDate.toFixed(1)}h ` +
        `(${isWholeDay ? 'the full day' : 'since local midnight'}) ` +
        `(max plausible: ${maxFirstSync})`,
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
    severity = steps > physicalDayBound ? 'implausible' : 'clamped';
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

module.exports = { validateSteps };
