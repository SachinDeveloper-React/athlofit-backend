// src/utils/stepsTracking.js
//
// Single source of truth for the per-user step-tracking kill switch.
//
// Deliberately narrower than a ban. A user whose device is producing bad step
// data still gets the shop, hydration, meals, challenges and their existing
// coin balance — only the step pipeline (ingest + step-derived coins) stops.
// Everything that reads the switch goes through here so the shape of the flag
// can change in one place.

/** Stable code clients branch on. Do not change — the app and the native
 *  Android service both string-match it. */
const STEPS_DISABLED_CODE = 'STEPS_TRACKING_DISABLED';

const DEFAULT_REASON =
  'Step tracking has been paused on your account. Please contact support.';

/** True when this user is currently allowed to submit / earn from steps. */
function isStepsTrackingEnabled(user) {
  // Absent sub-document means "never touched" — enabled, matching the schema
  // default. Existing users predate this field, so treating undefined as
  // disabled would switch off the entire user base on deploy.
  return user?.stepsTracking?.enabled !== false;
}

/** Client-facing status object. Safe to embed in any response. */
function stepsTrackingStatus(user) {
  const enabled = isStepsTrackingEnabled(user);
  return {
    enabled,
    reason: enabled ? null : user?.stepsTracking?.reason || DEFAULT_REASON,
    disabledAt: enabled ? null : user?.stepsTracking?.disabledAt || null,
  };
}

/**
 * Express guard. Returns true when the request was rejected — callers must
 * `return` immediately if so.
 *
 *   if (rejectIfStepsDisabled(req, res)) return;
 */
function rejectIfStepsDisabled(req, res) {
  const { error } = require('./response');
  if (isStepsTrackingEnabled(req.user)) return false;
  const status = stepsTrackingStatus(req.user);
  error(res, status.reason, 403, STEPS_DISABLED_CODE);
  return true;
}

module.exports = {
  STEPS_DISABLED_CODE,
  DEFAULT_REASON,
  isStepsTrackingEnabled,
  stepsTrackingStatus,
  rejectIfStepsDisabled,
};
