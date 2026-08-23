// src/utils/syncLog.js
//
// Decides which /health/sync calls are worth recording, and writes them.
//
// The decision is the whole design. Devices post every ~15 minutes around the
// clock, so "log everything" is six-figure daily writes for a debugging aid,
// and "log nothing" is where we were — no way to answer what a device actually
// sent. This picks the middle: always keep the syncs that are anomalous, and
// let an admin switch on full tracing for one account under investigation.

const SyncLog = require('../models/SyncLog.model');

/**
 * A step increase larger than this in a single sync is recorded even when the
 * validator was happy with it.
 *
 * 3,000 is roughly half an hour of brisk walking. A phone syncing every 15
 * minutes should rarely produce it, but a device flushing a backlog, a watch
 * dumping records, or a counting bug all will — and those are exactly the
 * events that were invisible. The reported problem was 5,000-step jumps, which
 * this catches comfortably while leaving ordinary quarter-hourly deltas alone.
 */
const LARGE_JUMP_STEPS = 3000;

/**
 * Is verbose tracing currently switched on for this user?
 *
 * Tracing expires on its own. Left on indefinitely it silently becomes
 * "log everything forever" for that account, which is the volume problem this
 * module exists to avoid — and nobody remembers to turn it back off.
 */
function isTracing(user) {
  const dbg = user?.syncDebug;
  if (!dbg?.enabled) return false;
  if (dbg.expiresAt && new Date(dbg.expiresAt).getTime() < Date.now()) return false;
  return true;
}

/**
 * Why this sync should be recorded, or null to skip it.
 *
 * Ordered by diagnostic value, most specific first, so the stored `logReason`
 * names the most informative thing about the sync rather than whichever
 * condition happened to be checked first.
 *
 * @param {object} p
 * @param {boolean} p.tracing       verbose mode on for this user
 * @param {boolean} p.rejected      the sync was refused (kill switch / build gate)
 * @param {string}  p.severity      validator severity
 * @param {boolean} p.flagged       validator raised a flag
 * @param {boolean} p.corrected     client asked to walk its own count back
 * @param {number}  p.incomingSteps
 * @param {number}  p.clampedSteps
 * @param {number}  p.existingSteps
 * @returns {string|null}
 */
function resolveLogReason({
  tracing,
  rejected,
  severity,
  flagged,
  corrected,
  incomingSteps,
  clampedSteps,
  existingSteps,
}) {
  if (rejected) return 'rejected';
  if (severity === 'implausible') return 'implausible';
  // The validator changed the number. Whatever else is true, the stored figure
  // is not what the device said, and that difference is the single most useful
  // thing to have a record of.
  if (clampedSteps !== incomingSteps) return 'clamped';
  if (corrected) return 'corrected';
  if (flagged) return 'flagged';
  if (incomingSteps - existingSteps >= LARGE_JUMP_STEPS) return 'large_jump';
  // Nothing unusual — kept only when someone is actively watching this account.
  if (tracing) return 'trace';
  return null;
}

/**
 * Record a sync if it is worth recording. Fire-and-forget.
 *
 * Never awaited and never throws: this is diagnostics riding on the hot sync
 * path, and it must not be able to slow down or fail a user's step submission.
 */
function recordSyncLog(req, {
  date,
  incomingSteps = 0,
  existingSteps = 0,
  clampedSteps = 0,
  storedSteps = 0,
  flagged = false,
  severity = 'none',
  reason = null,
  corrected = false,
  rejected = false,
  timezone = null,
}) {
  try {
    const logReason = resolveLogReason({
      tracing: isTracing(req.user),
      rejected,
      severity,
      flagged,
      corrected,
      incomingSteps,
      clampedSteps,
      existingSteps,
    });
    if (!logReason) return;

    SyncLog.create({
      user: req.user._id,
      date,
      incomingSteps,
      existingSteps,
      clampedSteps,
      storedSteps,
      flagged,
      severity,
      reason,
      corrected,
      appVersion: req.deviceCtx?.appVersion || null,
      buildNumber: req.deviceCtx?.buildNumber || null,
      platform: req.deviceCtx?.platform || null,
      clientSource: req.deviceCtx?.lastSource || null,
      timezone: timezone || null,
      logReason,
    }).catch(() => {});
  } catch {
    // Diagnostics must never break the thing they are diagnosing.
  }
}

module.exports = { recordSyncLog, resolveLogReason, isTracing, LARGE_JUMP_STEPS };
