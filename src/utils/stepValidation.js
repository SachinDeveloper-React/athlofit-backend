// src/utils/stepValidation.js
//
// Server-side step validation / anti-cheat.
//
// Validates incoming step counts against physiological limits and
// rate-of-change rules. Returns the clamped (safe) step count and
// flags suspicious submissions.
//
// Rules:
//   1. Absolute daily cap: configurable (default 50,000 for very active users)
//   2. Rate cap: max ~200 steps/minute = 12,000 steps/hour
//   3. No-decrease rule: steps should not decrease within a day
//      (allow a small tolerance for sensor corrections). Overridable via
//      `allowCorrection` so a client that over-reported can repair the record —
//      without it, one bad figure was the stored value for the rest of the day.
//   4. Single-sync jump cap: max 5,000 steps in under 5 minutes
//      (prevents "inject 50k steps in one API call" attacks)
//   5. First-sync plausibility: on the first sync of the day, the step count
//      is bounded by time-of-day × max step rate.

const MAX_DAILY_STEPS = 50_000; // realistic daily cap (marathon = ~42k steps)
const MAX_STEPS_PER_HOUR = 12_000; // ~200 steps/min sustained (running)
const MAX_STEPS_PER_MINUTE = 220; // absolute burst (sprinting)
const DECREASE_TOLERANCE = 100; // allow small sensor corrections
const RAPID_JUMP_THRESHOLD = 5_000; // max step jump in < 5 min
const RAPID_JUMP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MIN_ELAPSED_FOR_RATE_CHECK = 2; // minutes — skip rate check if syncs are < 2 min apart

/**
 * Validates incoming step count and returns a safe value.
 *
 * @param {object} params
 * @param {number|null|undefined} params.incomingSteps - Raw step count from client
 * @param {number} params.existingSteps - Previously stored step count for today
 * @param {number} params.bonusSteps - Bonus steps (admin-credited, not from device)
 * @param {Date|null} params.lastSyncAt - Timestamp of last sync (updatedAt of HealthActivity)
 * @param {number} params.dailyGoal - User's daily step goal (for context only)
 * @param {boolean} [params.allowCorrection] - When true, a decrease below the stored
 *   value is accepted instead of being silently raised back up. The client sets this
 *   only when it has detected that its own previously reported figure was too high.
 *
 * @returns {{ clampedSteps: number, flagged: boolean, reason: string|null,
 *   corrected: boolean, correctedFrom: number|null }}
 */
function validateSteps({ incomingSteps, existingSteps, bonusSteps, lastSyncAt, dailyGoal, allowCorrection = false }) {
  // If no steps provided or negative, return 0
  if (incomingSteps === undefined || incomingSteps === null || incomingSteps < 0) {
    return { clampedSteps: 0, flagged: false, reason: null, corrected: false, correctedFrom: null };
  }

  let steps = Math.round(incomingSteps);
  const existingWalked = Math.max(0, existingSteps - bonusSteps);

  let flagged = false;
  let reason = null;

  // ── Rule 1: Absolute daily cap ──────────────────────────────────────────────
  if (steps > MAX_DAILY_STEPS) {
    flagged = true;
    reason = `Exceeded daily cap (${steps} > ${MAX_DAILY_STEPS})`;
    steps = MAX_DAILY_STEPS;
  }

  // ── Rule 5: First-sync plausibility ─────────────────────────────────────────
  // On the first sync of the day (no existing record, no lastSyncAt), the total
  // step count must be plausible given how many hours have passed today (IST).
  // This prevents injecting 50k steps in the first API call of the day.
  if (!lastSyncAt && existingWalked === 0 && steps > 0) {
    // Hours elapsed since midnight IST
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const hoursSinceMidnight = nowIST.getHours() + nowIST.getMinutes() / 60;
    // A very active person: ~150 steps/min sustained (brisk walk/run average)
    // = 9,000 steps/hour. Use that as max plausible for the first sync.
    const maxFirstSync = Math.max(3000, Math.ceil(hoursSinceMidnight * 9000));

    if (steps > maxFirstSync) {
      flagged = true;
      reason = `First sync too high: ${steps} steps, only ${hoursSinceMidnight.toFixed(1)}h since midnight (max plausible: ${maxFirstSync})`;
      steps = maxFirstSync;
    }
  }

  // ── Rule 2 + 4: Rate-of-change validation (subsequent syncs) ────────────────
  if (lastSyncAt && steps > existingWalked) {
    const elapsedMs = Date.now() - new Date(lastSyncAt).getTime();
    const elapsedMinutes = elapsedMs / 60_000;
    const elapsedHours = elapsedMs / 3_600_000;
    const stepDelta = steps - existingWalked;

    if (elapsedMinutes >= MIN_ELAPSED_FOR_RATE_CHECK) {
      const stepsPerMinute = stepDelta / elapsedMinutes;

      // Burst rate check (windows < 1 hour)
      if (stepsPerMinute > MAX_STEPS_PER_MINUTE && elapsedMinutes < 60) {
        flagged = true;
        reason = `Rate too high: ${Math.round(stepsPerMinute)} steps/min over ${Math.round(elapsedMinutes)} min`;
        const maxPossible = Math.round(elapsedMinutes * MAX_STEPS_PER_MINUTE);
        steps = existingWalked + maxPossible;
      }

      // Hourly rate check (windows >= 1 hour)
      if (elapsedHours >= 1) {
        const stepsPerHour = stepDelta / elapsedHours;
        if (stepsPerHour > MAX_STEPS_PER_HOUR) {
          flagged = true;
          reason = `Hourly rate too high: ${Math.round(stepsPerHour)} steps/hr over ${elapsedHours.toFixed(1)} hrs`;
          const maxPossible = Math.round(elapsedHours * MAX_STEPS_PER_HOUR);
          steps = existingWalked + maxPossible;
        }
      }
    }

    // Rapid single-sync jump (< 5 min window)
    if (elapsedMs < RAPID_JUMP_WINDOW_MS && stepDelta > RAPID_JUMP_THRESHOLD) {
      flagged = true;
      reason = `Rapid jump: +${stepDelta} steps in ${Math.round(elapsedMs / 1000)}s`;
      steps = existingWalked + RAPID_JUMP_THRESHOLD;
    }
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

  return { clampedSteps: steps, flagged, reason, corrected, correctedFrom };
}

module.exports = { validateSteps };
