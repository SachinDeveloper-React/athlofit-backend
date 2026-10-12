// src/utils/stepStatusReport.js
//
// Normalises the device-side step-pipeline status the app reports about itself.
//
// ── Why this is validated rather than stored as sent ────────────────────────
//
// This is the one diagnostic channel the server cannot corroborate against
// anything. Every other field in the step pipeline is checked against something
// — the step count against a baseline, the origin against 28 days of history —
// but nobody can verify a phone's claim about its own permission dialog. So the
// only guarantee worth having is that whatever reaches the admin panel is in a
// shape an admin can read: a known enum value or null, never a free-text
// surprise and never an unbounded string from the network.
//
// Unknown values become null rather than being stored verbatim. A null reads as
// "this build does not say", which is true and useful; a stored "GRANTED_MAYBE"
// would read as a finding and quietly mean nothing.

/** Permission states, in the vocabulary both platforms can express. */
const PERMISSION_STATES = new Set([
  'granted',
  'denied',
  'never_asked',
  'restricted',
  'unknown',
]);

/** Health Connect install states. Android-only; iOS reports 'not_supported'. */
const HC_AVAILABILITY = new Set([
  'installed',
  'not_installed',
  'update_required',
  'not_supported',
]);

/** Outcome of the device's own step read, independent of whether it synced. */
const READ_STATUSES = new Set(['ok', 'empty', 'error', 'permission_denied']);

/** Why a sync attempt died before the server could see it. */
const SYNC_ERRORS = new Set([
  'network_error',
  'auth_error',
  'server_error',
  'timeout',
  'cancelled',
  'unknown',
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const enumOrNull = (value, allowed) => {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return allowed.has(v) ? v : null;
};

const boolOrNull = (value) => (typeof value === 'boolean' ? value : null);

/**
 * A step count the device claims. Bounded, because this is displayed next to
 * the stored figure and an absurd number there would read as a server bug
 * rather than as the device talking nonsense.
 */
const stepsOrNull = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), 1_000_000);
};

const textOrNull = (value, max = 200) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

const dateOrNull = (value) => {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value.trim())) return null;
  return value.trim();
};

/**
 * A timestamp the device reports. Refused if it is in the future by more than a
 * little clock skew: a device with a wrong clock would otherwise plant a
 * "last attempt" that never ages, and a reader cannot tell that from a fresh
 * one.
 */
const pastDateOrNull = (value, now = Date.now()) => {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  if (t > now + 5 * 60 * 1000) return null;
  return new Date(t);
};

/**
 * Normalise a reported status payload into the shape stored on User.stepStatus.
 *
 * Accepts the nested shape the app sends and flattens it, because the stored
 * document is read field-by-field by the admin view and a nested optional
 * object there means every reader writes the same three null checks.
 *
 * @param {object} body - raw request body
 * @param {object} [opts]
 * @param {string|null} [opts.appVersion] - from the X-App-Version header, not
 *   the body: the build is something the server observes, and taking it from
 *   the payload would let a stale report claim to be from a current build.
 * @param {number} [opts.now]
 * @returns {object} always a complete stepStatus document; absent fields null.
 */
function normaliseStepStatusReport(body = {}, { appVersion = null, now = Date.now() } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const permissions = b.permissions && typeof b.permissions === 'object' ? b.permissions : {};
  const hc = b.healthConnect && typeof b.healthConnect === 'object' ? b.healthConnect : {};
  const local = b.localSteps && typeof b.localSteps === 'object' ? b.localSteps : {};
  const attempt =
    b.lastSyncAttempt && typeof b.lastSyncAttempt === 'object' ? b.lastSyncAttempt : {};

  return {
    activityPermission: enumOrNull(permissions.activityRecognition, PERMISSION_STATES),
    healthConnectPermission: enumOrNull(permissions.healthConnect, PERMISSION_STATES),
    healthConnectAvailability: enumOrNull(hc.availability, HC_AVAILABILITY),
    hasStepWriter: boolOrNull(hc.hasStepWriter),

    localStepsToday: stepsOrNull(local.today),
    localStepsDate: dateOrNull(local.date),
    readStatus: enumOrNull(local.readStatus, READ_STATUSES),
    readError: textOrNull(local.readError),

    lastSyncAttemptAt: pastDateOrNull(attempt.at, now),
    lastSyncOk: boolOrNull(attempt.ok),
    lastSyncError: enumOrNull(attempt.error, SYNC_ERRORS),

    batteryOptimisationIgnored: boolOrNull(b.batteryOptimisationIgnored),

    reportedAt: new Date(now),
    reportedAppVersion: textOrNull(appVersion, 32),
  };
}

/**
 * True when a normalised report carries nothing but its own timestamp.
 *
 * Worth checking before writing: a build that sends an empty object on a timer
 * would otherwise overwrite a genuinely informative older report with nulls,
 * and "we knew the permission was denied yesterday" is more useful than
 * "we know nothing now".
 */
function isEmptyStepStatusReport(report) {
  if (!report) return true;
  return [
    'activityPermission',
    'healthConnectPermission',
    'healthConnectAvailability',
    'hasStepWriter',
    'localStepsToday',
    'readStatus',
    'readError',
    'lastSyncAttemptAt',
    'lastSyncOk',
    'lastSyncError',
    'batteryOptimisationIgnored',
  ].every((k) => report[k] == null);
}

/**
 * The one-line reading of a status report, for the admin panel.
 *
 * Ordered by how actionable each state is: a permission that was never asked
 * for is a different support reply from one that was explicitly refused, and
 * both are different from a phone with permission and no app writing steps.
 *
 * @returns {{code: string, label: string}|null} null when the report says
 *   nothing conclusive — the caller should fall back to server-side inference.
 */
function summariseStepStatus(report) {
  if (!report || isEmptyStepStatusReport(report)) return null;

  const activity = report.activityPermission;
  const hcPerm = report.healthConnectPermission;
  const availability = report.healthConnectAvailability;

  if (activity === 'denied' || hcPerm === 'denied') {
    return {
      code: 'PERMISSION_DENIED',
      label: 'The user refused step permission on the device',
    };
  }
  if (activity === 'never_asked' || hcPerm === 'never_asked') {
    return {
      code: 'PERMISSION_NEVER_ASKED',
      label: 'Step permission has never been requested on this device',
    };
  }
  if (availability === 'not_installed') {
    return {
      code: 'HEALTH_CONNECT_MISSING',
      label: 'Health Connect is not installed on this device',
    };
  }
  if (availability === 'update_required') {
    return {
      code: 'HEALTH_CONNECT_OUTDATED',
      label: 'Health Connect needs updating before it can be read',
    };
  }
  if (report.hasStepWriter === false) {
    return {
      code: 'NO_STEP_WRITER',
      label: 'No app on the phone is writing steps for us to read',
    };
  }
  if (report.readStatus === 'error') {
    return {
      code: 'DEVICE_READ_ERROR',
      label: 'The device failed to read its own step data',
    };
  }
  if (report.lastSyncOk === false && report.lastSyncError) {
    return {
      code: `SYNC_FAILED_${report.lastSyncError.toUpperCase()}`,
      label: `The last sync attempt never reached the server (${report.lastSyncError})`,
    };
  }
  return null;
}

module.exports = {
  normaliseStepStatusReport,
  isEmptyStepStatusReport,
  summariseStepStatus,
  PERMISSION_STATES,
  HC_AVAILABILITY,
  READ_STATUSES,
  SYNC_ERRORS,
};
