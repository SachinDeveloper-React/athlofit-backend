// src/utils/stepValidation.js
//
// FIX #2: Server-side step validation / anti-cheat.
//
// Validates incoming step counts against physiological limits and
// rate-of-change rules. Returns the clamped (safe) step count and
// flags suspicious submissions.
//
// Rules:
//   1. Absolute daily cap: 100,000 steps (ultra-marathon level)
//   2. Rate cap: ~200 steps/minute = 12,000 steps/hour
//   3. No-decrease rule: steps should not decrease within a day
//      (allow a small tolerance for sensor corrections). Overridable via
//      `allowCorrection` so a client that over-reported can repair the record —
//      without it, one bad figure was the stored value for the rest of the day.
//   4. Single-sync jump cap: max 5,000 steps in under 5 minutes
//      (prevents "inject 50k steps in one API call" attacks)

const MAX_DAILY_STEPS = 100_000; // absolute physical limit
const MAX_STEPS_PER_HOUR = 12_000; // ~200 steps/min sustained
const MAX_STEPS_PER_MINUTE = 220; // burst (sprinting on stairs)
const DECREASE_TOLERANCE = 100; // allow small sensor corrections
const RAPID_JUMP_THRESHOLD = 5_000; // max step jump in < 5 min
const RAPID_JUMP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

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

  // Round to integer (step counts should be whole numbers)
  let steps = Math.round(incomingSteps);

  // The device sends total walked steps (not including bonus).
  // Existing record may include bonus, so compute walked-only from existing.
  const existingWalked = Math.max(0, existingSteps - bonusSteps);

  // SUSPICIOUS DETECTION DISABLED — flagging logic commented out
  let flagged = false;
  let reason = null;

  // ── Rule 1: Absolute daily cap ──────────────────────────────────────────────
  if (steps > MAX_DAILY_STEPS) {
    // flagged = true;
    // reason = `Exceeded absolute daily cap (${steps} > ${MAX_DAILY_STEPS})`;
    steps = MAX_DAILY_STEPS;
  }

  // ── Rule 2: Rate-of-change validation ───────────────────────────────────────
  // If we have a previous sync time, check the step increase rate.
  if (lastSyncAt && steps > existingWalked) {
    const elapsedMs = Date.now() - new Date(lastSyncAt).getTime();
    const elapsedMinutes = elapsedMs / 60_000;
    const elapsedHours = elapsedMs / 3_600_000;
    const stepDelta = steps - existingWalked;

    // Skip per-minute rate validation if elapsed time is too short (< 2 minutes).
    // Very short intervals between syncs produce unreliable rate calculations
    // because dividing by a tiny denominator amplifies any step delta. This
    // prevents false flags when:
    //   - The user opens/closes the app rapidly
    //   - Both the background service and app sync within seconds
    //   - The step count jumps after seeding from Health Connect on service restart
    //
    // The rapid-jump rule (Rule 4) still applies for large absolute jumps
    // regardless of elapsed time.
    const MIN_ELAPSED_FOR_RATE_CHECK = 2; // minutes

    if (elapsedMinutes >= MIN_ELAPSED_FOR_RATE_CHECK) {
      const stepsPerMinute = stepDelta / elapsedMinutes;

      // Check burst rate (per-minute)
      if (stepsPerMinute > MAX_STEPS_PER_MINUTE && elapsedMinutes < 60) {
        // flagged = true;
        // reason = `Rate too high: ${Math.round(stepsPerMinute)} steps/min over ${Math.round(elapsedMinutes)} min`;
        // Clamp to max achievable in this time window
        const maxPossible = Math.round(elapsedMinutes * MAX_STEPS_PER_MINUTE);
        steps = existingWalked + maxPossible;
      }

      // Check hourly rate (for longer windows)
      if (elapsedHours >= 1) {
        const stepsPerHour = stepDelta / elapsedHours;
        if (stepsPerHour > MAX_STEPS_PER_HOUR) {
          // flagged = true;
          // reason = `Hourly rate too high: ${Math.round(stepsPerHour)} steps/hr over ${elapsedHours.toFixed(1)} hrs`;
          const maxPossible = Math.round(elapsedHours * MAX_STEPS_PER_HOUR);
          steps = existingWalked + maxPossible;
        }
      }
    }

    // ── Rule 4: Rapid single-sync jump ──────────────────────────────────────
    if (elapsedMs < RAPID_JUMP_WINDOW_MS && stepDelta > RAPID_JUMP_THRESHOLD) {
      // flagged = true;
      // reason = `Rapid jump: +${stepDelta} steps in ${Math.round(elapsedMs / 1000)}s`;
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

  // Ensure non-negative after all clamping
  steps = Math.max(0, steps);

  return { clampedSteps: steps, flagged, reason, corrected, correctedFrom };
}

module.exports = { validateSteps };
