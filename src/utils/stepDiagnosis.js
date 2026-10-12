// src/utils/stepDiagnosis.js
//
// "Why does this user show 0 steps?" — the decision, separated from the query.
//
// Split out of admin.controller.js for the same reason coinBlock.js was split
// out of cheatPenalty.js: the controller transitively requires firebase-admin,
// which initialises at require time and cannot run in a test. The rule that
// actually decides what an admin is told therefore had no way to be pinned
// down, and this is a rule that will be read as authoritative by whoever is
// answering a support ticket.
//
// ── The inference this exists for ───────────────────────────────────────────
//
// `lastActiveAt` is bumped by EVERY authenticated request (auth.middleware),
// background step syncs included. Step data lands separately, on
// HealthActivity. Reading the two TOGETHER separates two causes that are
// indistinguishable if you only look at the step count:
//
//   app reaching the server, no steps arriving  → the device's step pipeline is
//     broken (permission revoked, Health Connect disconnected, no step writer).
//     The app itself is fine, and reinstalling it will not help.
//   nothing reaching the server at all          → the app is not running: force
//     -stopped, battery-killed, logged out, uninstalled, or never opened.
//
// ── What it deliberately refuses to guess ───────────────────────────────────
//
// The server sees SILENCE, never the reason for it. Both clients skip posting a
// day that reads zero steps, so "permission denied", "Health Connect not
// connected" and "app never ran" all arrive as the same absence of rows. Where
// the evidence only narrows the cause to a set, the verdict says so in words
// rather than naming one of them and being confidently wrong.

/** Hours within which an authenticated request counts the app as "running". */
const ACTIVE_WINDOW_HOURS = 24;

/**
 * The most specific explanation that fits — not whichever check ran first.
 *
 * Order matters and is deliberate. An admin kill switch or a blocked build
 * explains every silence downstream of it, so those are reported before any
 * inference drawn from the silence they themselves caused. Reversing the order
 * would report "the app has stopped contacting the server" for an account the
 * server is actively turning away.
 *
 * @param {object} p
 * @param {boolean} p.stepsTrackingEnabled - User.stepsTracking.enabled !== false
 * @param {string|null} [p.stepsTrackingReason]
 * @param {boolean} p.buildGateBlocked - checkStepSyncVersion().blocked
 * @param {string|null} [p.buildGateReason]
 * @param {boolean} p.hasTelemetry - device.appVersion is present
 * @param {boolean} p.everSynced - any HealthActivity row has ever existed
 * @param {number} p.todaySteps
 * @param {number|null} p.hoursSinceActive - null when never seen
 * @param {number|null} [p.hoursSinceStepData]
 * @param {number} [p.rejectedSyncs]
 * @param {number} [p.clampedSyncs]
 * @param {{code: string, label: string}|null} [p.deviceReport] - from
 *   summariseStepStatus(), when the app has reported its own state.
 * @param {number|null} [p.localStepsToday] - the count the APP believes it has.
 * @returns {{code: string, label: string, detail: string, source: string}}
 */
function decideVerdict({
  stepsTrackingEnabled,
  stepsTrackingReason = null,
  buildGateBlocked,
  buildGateReason = null,
  hasTelemetry,
  everSynced,
  todaySteps,
  hoursSinceActive,
  hoursSinceStepData = null,
  rejectedSyncs = 0,
  clampedSyncs = 0,
  deviceReport = null,
  localStepsToday = null,
}) {
  if (!stepsTrackingEnabled) {
    return {
      code: 'STEPS_DISABLED_BY_ADMIN',
      label: 'Step tracking switched off by an admin',
      detail:
        `This account's step pipeline is disabled${stepsTrackingReason ? ` — "${stepsTrackingReason}"` : ''}. ` +
        'POST /health/sync is refused and no step coins are awarded. Nothing below is a device fault.',
    };
  }

  if (buildGateBlocked) {
    return {
      code: 'BUILD_BLOCKED',
      label: 'This app build is blocked from syncing steps',
      detail:
        `The version gate is refusing this build${buildGateReason ? ` — "${buildGateReason}"` : ''}. ` +
        'The user must update. Silent days are simply days the client was turned away.',
    };
  }

  if (rejectedSyncs > 0) {
    return {
      code: 'SYNCS_REJECTED',
      label: 'The device is syncing, but the server is rejecting it',
      detail:
        `${rejectedSyncs} rejected sync(s) in the recent trail. See recentIssues for the reason on each.`,
    };
  }

  // ── What the device said about itself ─────────────────────────────────────
  //
  // Placed here deliberately: after the three things the SERVER directly
  // observed (its own kill switch, its own gate, its own rejections) and
  // before everything inferred from silence. A reported permission state is
  // first-hand evidence of the cause; every branch below it is a deduction
  // from the absence of data, and a deduction must never outrank a report
  // that settles the same question.
  if (deviceReport) {
    return {
      code: deviceReport.code,
      label: deviceReport.label,
      detail:
        'Reported by the app itself, so this is the cause rather than an inference ' +
        'drawn from missing data. Fix it on the device.',
      source: 'device',
    };
  }

  // The app believes it has steps the server does not. Checked before the
  // silence branches because it is the one case where silence is OUR problem:
  // the data exists on the phone and is not arriving, which is a delivery
  // failure, not a device-side step-reading failure.
  if (localStepsToday > 0 && !todaySteps) {
    return {
      code: 'APP_HAS_STEPS_SERVER_DOES_NOT',
      label: 'The app is counting steps that never reached us',
      detail:
        `The device reports ${localStepsToday} steps today while the server has none. The step read ` +
        'is working, so this is a delivery problem — failed syncs, a blocked request, or a date ' +
        'mismatch between the device and the stored row.',
      source: 'device',
    };
  }

  if (!everSynced) {
    // Not one HealthActivity row has ever existed. The question that splits
    // this is whether the app has EVER authenticated — signup alone does not
    // bump lastActiveAt beyond the registration call itself.
    if (hoursSinceActive == null) {
      return {
        code: 'NEVER_USED_APP',
        label: 'Signed up, but the app has never called the server',
        detail:
          'No authenticated request has ever been recorded for this account, and no step data exists. ' +
          'The user registered and never got the app running.',
      };
    }
    return {
      code: 'APP_RUNS_BUT_NEVER_SENT_STEPS',
      label: 'App is reaching the server, but has never sent a single step',
      detail:
        'Authenticated requests exist, so the app runs and the login works — but no HealthActivity row ' +
        'has ever been written. This is the signature of step permission never granted, or Health Connect ' +
        'never connected. Confirm on the device.',
    };
  }

  if (hoursSinceActive == null || hoursSinceActive > ACTIVE_WINDOW_HOURS) {
    return {
      code: 'APP_NOT_RUNNING',
      label: 'The app has stopped contacting the server',
      detail:
        hoursSinceActive == null
          ? 'No authenticated request on record. Likely uninstalled or force-stopped.'
          : `Last authenticated request was ${Math.round(hoursSinceActive)}h ago. ` +
            'Force-stop, battery optimisation, logged out, or uninstalled.',
    };
  }

  // Past this point the app IS alive and authenticated, so anything missing is
  // device-side step data rather than the app not running.
  if (!todaySteps) {
    return {
      code: 'APP_ALIVE_BUT_NO_STEPS',
      label: 'App is running and authenticated, but no steps are arriving',
      detail:
        `The app contacted the server ${Math.round(hoursSinceActive)}h ago, so it is installed, running ` +
        'and logged in — it simply has no step data to send. That rules out force-stop and gating, and ' +
        'points at the device-side step read: Health Connect permission revoked, the step source removed, ' +
        'or no step-writing app (Google Fit / Samsung Health) active.' +
        (hoursSinceStepData != null
          ? ` Last steps actually received: ${Math.round(hoursSinceStepData)}h ago.`
          : ''),
    };
  }

  if (clampedSyncs > 0) {
    return {
      code: 'STEPS_CLAMPED',
      label: 'Steps are arriving but the server is reducing them',
      detail:
        `${clampedSyncs} sync(s) in the recent trail were clamped or flagged by validation. ` +
        'The app may show a higher count than the admin panel — see recentIssues.',
    };
  }

  if (!hasTelemetry) {
    return {
      code: 'HEALTHY_NO_TELEMETRY',
      label: 'Steps are arriving, but the build is too old to identify',
      detail:
        'This device has never sent version headers, so it predates build telemetry. Steps are flowing, ' +
        'but which code path produced them cannot be determined, and no fix shipped since then is on it.',
    };
  }

  return {
    code: 'HEALTHY',
    label: 'Steps are arriving normally',
    detail: `${todaySteps} steps recorded today.`,
  };
}

/**
 * As decideVerdict, with `source` always present.
 *
 * Stamped here rather than on each branch so a new branch cannot ship without
 * it. 'server' means the verdict was deduced from what we observed; 'device'
 * means the app told us outright. An admin reading "permission denied" needs
 * to know which of those it is before acting on it, and the two warrant
 * different confidence.
 */
function resolveStepDiagnosisVerdict(input) {
  return { source: 'server', ...decideVerdict(input) };
}

module.exports = { resolveStepDiagnosisVerdict, ACTIVE_WINDOW_HOURS };
