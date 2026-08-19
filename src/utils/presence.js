// src/utils/presence.js
// ─── User online/offline presence ────────────────────────────────────────────
//
// This is a heartbeat/last-seen model (not a persistent socket). A user is
// considered ONLINE when:
//   1. They have not explicitly reported being backgrounded/closed
//      (isForeground !== false), AND
//   2. Their last foreground activity (lastSeenAt) is within ONLINE_THRESHOLD_MS.
//
// Foreground activity is refreshed by the auth middleware on normal API calls
// and by the explicit POST /users/presence heartbeat. Background health syncs
// deliberately do NOT refresh presence, so a closed-but-syncing app does not
// appear online.

// How recent lastSeenAt must be to count as online. Should comfortably exceed
// the app's heartbeat interval (recommend the app ping every ~60s while open).
const ONLINE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

// Only refresh lastSeenAt at most this often, to avoid a DB write on every call.
const PRESENCE_WRITE_THROTTLE_MS = 60 * 1000; // 60 seconds

/**
 * Derive whether a user document is currently online.
 * @param {{ isForeground?: boolean, lastSeenAt?: Date|string|null }} user
 * @returns {boolean}
 */
function isUserOnline(user) {
  if (!user) return false;
  if (user.isForeground === false) return false; // explicitly backgrounded/closed
  if (!user.lastSeenAt) return false;
  const seen = new Date(user.lastSeenAt).getTime();
  if (Number.isNaN(seen)) return false;
  return Date.now() - seen < ONLINE_THRESHOLD_MS;
}

// After this many days with no activity, a user is considered "inactive"
// (likely churned, even if we have no explicit uninstall signal).
const INACTIVE_AFTER_DAYS = 14;

/**
 * Derive an app lifecycle status for admin display:
 *   - 'uninstalled' : Firebase reported the push token unregistered (likely uninstall)
 *   - 'inactive'    : no activity for INACTIVE_AFTER_DAYS (heuristic churn)
 *   - 'active'      : seen recently
 * @param {{ appUninstalledAt?: Date|null, lastSeenAt?: Date|null, lastActiveAt?: Date|null }} user
 * @returns {'uninstalled'|'inactive'|'active'}
 */
function getAppStatus(user) {
  if (!user) return 'inactive';
  if (user.appUninstalledAt) return 'uninstalled';
  const last = user.lastSeenAt || user.lastActiveAt;
  if (!last) return 'inactive';
  const days = (Date.now() - new Date(last).getTime()) / (1000 * 60 * 60 * 24);
  return days >= INACTIVE_AFTER_DAYS ? 'inactive' : 'active';
}

module.exports = {
  isUserOnline,
  getAppStatus,
  ONLINE_THRESHOLD_MS,
  PRESENCE_WRITE_THROTTLE_MS,
  INACTIVE_AFTER_DAYS,
};
