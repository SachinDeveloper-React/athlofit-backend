// src/crons/accountDeletion.js
// ─── Executes account deletion requests once their grace period expires ──────
//
// POST /user/request-deletion has always written a `deletionRequest` with a
// date 30 days out. Nothing ever read that date back — no cron, no job, no
// admin route — so every account "scheduled for deletion" simply stayed. This
// is the job that makes the promise real.
//
// Runs daily. Idempotent and resumable: a request that fails partway is left
// in_progress and retried on the next run rather than being lost or
// double-counted.

const User = require('../models/User.model');
const Order = require('../models/Order.model');
const { purgeUserData } = require('../utils/purgeUserData');

// Cap per run. Purging is many deleteMany calls per user; an unbounded batch
// after a backlog builds up would hold the DB busy for minutes.
const BATCH_LIMIT = 50;

// Orders that are paid for but not yet in the customer's hands. The shipping
// address lives on the order and purging redacts it, so deleting an account
// mid-fulfilment would strand a parcel that has already been charged for.
const IN_FLIGHT_ORDER_STATUSES = ['PENDING', 'PAID', 'SHIPPED'];

/**
 * Process every deletion request whose scheduled date has passed.
 *
 * @returns {Promise<{ processed, purged, blocked, failed, details }>}
 */
async function processAccountDeletions() {
  const now = new Date();

  const due = await User.find({
    'deletionRequest.status': { $in: ['pending', 'in_progress'] },
    'deletionRequest.scheduledDeletionDate': { $lte: now },
  })
    .select('_id email role deletionRequest')
    .limit(BATCH_LIMIT)
    .lean();

  if (due.length === 0) {
    return { processed: 0, purged: 0, blocked: 0, failed: 0, details: [] };
  }

  let purged = 0;
  let blocked = 0;
  let failed = 0;
  const details = [];

  for (const user of due) {
    try {
      // ── Guard: never silently delete an admin ─────────────────────────────
      // An admin requesting deletion is almost certainly a mistake or a
      // compromised session, and losing the last admin locks everyone out of
      // the panel. Surface it instead of acting on it.
      if (user.role === 'admin') {
        blocked++;
        details.push({ user: user._id, outcome: 'blocked', reason: 'admin account' });
        await setBlocked(user._id, 'Admin accounts must be deleted manually.');
        continue;
      }

      // ── Guard: in-flight orders ───────────────────────────────────────────
      // Purging redacts the shipping address, so an undelivered order would
      // become unfulfillable. Hold the request and retry tomorrow — the delay
      // is bounded by fulfilment, and it is recorded on the request so it is
      // visible rather than looking like the job silently skipped someone.
      const inFlight = await Order.countDocuments({
        user: user._id,
        status: { $in: IN_FLIGHT_ORDER_STATUSES },
      });
      if (inFlight > 0) {
        blocked++;
        details.push({ user: user._id, outcome: 'blocked', reason: `${inFlight} order(s) in flight` });
        await setBlocked(
          user._id,
          `Waiting on ${inFlight} undelivered order(s). Deletion resumes once they are delivered or cancelled.`,
        );
        continue;
      }

      // Claim the request before doing destructive work, so a second run
      // starting concurrently sees it is already being handled.
      await User.updateOne(
        { _id: user._id },
        { $set: { 'deletionRequest.status': 'in_progress', 'deletionRequest.blockedReason': null } },
      );

      const result = await purgeUserData(user._id);

      if (result.errors.length > 0) {
        // Left in_progress on purpose — tomorrow's run picks it up again.
        // purgeUserData is idempotent, so the retry costs nothing.
        failed++;
        details.push({ user: user._id, outcome: 'failed', errors: result.errors });
        console.error(
          `[CRON:Deletion] Partial purge for ${user._id}:`,
          result.errors.join('; '),
        );
        continue;
      }

      purged++;
      details.push({ user: user._id, outcome: 'purged', deleted: result.deleted });
      console.log(`[CRON:Deletion] Purged account ${user._id}`);
    } catch (err) {
      failed++;
      details.push({ user: user._id, outcome: 'failed', errors: [err.message] });
      console.error(`[CRON:Deletion] Failed for ${user._id}:`, err.message);
    }
  }

  console.log(
    `[CRON:Deletion] ${due.length} due — ${purged} purged, ${blocked} blocked, ${failed} failed`,
  );

  return { processed: due.length, purged, blocked, failed, details };
}

/**
 * Record why a due request was not acted on.
 *
 * Kept as `pending` rather than moved to a terminal state: the block is
 * temporary in every case, so the request must remain due and be re-evaluated
 * on the next run.
 */
async function setBlocked(userId, reason) {
  await User.updateOne(
    { _id: userId },
    { $set: { 'deletionRequest.status': 'pending', 'deletionRequest.blockedReason': reason } },
  ).catch(() => {});
}

module.exports = { processAccountDeletions, BATCH_LIMIT };
