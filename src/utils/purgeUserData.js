// src/utils/purgeUserData.js
//
// Actually erases a user's account and personal data.
//
// This is the piece the deletion flow was missing. POST /user/request-deletion
// has always set `deletionRequest.status = 'pending'` with a date 30 days out,
// but nothing ever read that date back: no cron, no job, no admin route. Users
// were told their account would be deleted and it never was.
//
// ── Delete vs retain ────────────────────────────────────────────────────────
//
// Not everything can be dropped. Orders are financial records with accounting,
// tax and refund obligations that outlive the account, and admin audit logs
// exist precisely so that actions taken on an account remain reviewable after
// it is gone. Those are RETAINED, with the personal data scrubbed out of them —
// the record of "an order of ₹X shipped on date Y" survives, the name, phone
// and street address do not.
//
// Everything that is purely the user's own activity is hard-deleted.

const User = require('../models/User.model');
const HealthActivity = require('../models/HealthActivity.model');
const BmiRecord = require('../models/BmiRecord.model');
const MealLog = require('../models/MealLog.model');
const NutritionPreference = require('../models/NutritionPreference.model');
const SearchLog = require('../models/SearchLog.model');
const CoinTransaction = require('../models/CoinTransaction.model');
const Gamification = require('../models/Gamification.model');
const UserChallenge = require('../models/UserChallenge.model');
const Notification = require('../models/Notification.model');
const RefreshToken = require('../models/RefreshToken.model');
const CheatFlag = require('../models/CheatFlag.model');
const BonusSteps = require('../models/BonusSteps.model');
const Referral = require('../models/Referral.model');
const Order = require('../models/Order.model');
const SupportTicket = require('../models/SupportTicket.model');
const { deleteImage } = require('./uploadImage');

const REDACTED = 'REDACTED';

// Collections holding nothing but this user's own activity. Keyed by `user`,
// safe to drop outright.
const OWNED_BY_USER = [
  ['healthActivity', HealthActivity],
  ['bmiRecords', BmiRecord],
  ['mealLogs', MealLog],
  ['nutritionPreferences', NutritionPreference],
  ['searchLogs', SearchLog],
  ['coinTransactions', CoinTransaction],
  ['gamification', Gamification],
  ['userChallenges', UserChallenge],
  ['notifications', Notification],
  ['refreshTokens', RefreshToken],
  ['cheatFlags', CheatFlag],
  ['bonusSteps', BonusSteps],
];

/**
 * Erase a user and their personal data.
 *
 * Each step is independent and failures are collected rather than thrown: a
 * partial purge that reports what it could not remove is far better than one
 * that aborts halfway and leaves the account in a state no one can see. The
 * caller decides whether to mark the request completed based on `errors`.
 *
 * Idempotent — safe to re-run against an already-purged user, which matters
 * because the cron will retry anything it could not finish.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<{ deleted: Record<string, number>, errors: string[] }>}
 */
async function purgeUserData(userId) {
  const deleted = {};
  const errors = [];

  const run = async (label, fn) => {
    try {
      deleted[label] = await fn();
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
    }
  };

  // Read the user first — the avatar URL is needed before the document goes.
  let user = null;
  try {
    user = await User.findById(userId).select('avatarUrl email');
  } catch (err) {
    errors.push(`readUser: ${err.message}`);
  }

  // ── 1. Hard-delete the user's own activity data ───────────────────────────
  for (const [label, Model] of OWNED_BY_USER) {
    await run(label, async () => {
      const r = await Model.deleteMany({ user: userId });
      return r.deletedCount || 0;
    });
  }

  // ── 2. Referrals ──────────────────────────────────────────────────────────
  // Deleted from both sides. A referral row names two people, so leaving it
  // behind would keep the deleted user linked to someone else's account.
  await run('referrals', async () => {
    const r = await Referral.deleteMany({
      $or: [{ referrer: userId }, { referee: userId }],
    });
    return r.deletedCount || 0;
  });

  // ── 3. Orders — retain the record, scrub the person ───────────────────────
  // The order stays for accounting and refund history; every field that could
  // identify or locate the buyer is overwritten. `user` is left pointing at the
  // now-deleted id: it is a pseudonymous key that keeps per-order grouping
  // working and no longer resolves to a person.
  await run('ordersAnonymised', async () => {
    const r = await Order.updateMany(
      { user: userId },
      {
        $set: {
          contactEmail: null,
          contactPhone: null,
          'shippingAddress.street': REDACTED,
          'shippingAddress.city': REDACTED,
          'shippingAddress.state': REDACTED,
          'shippingAddress.zipCode': REDACTED,
        },
      },
    );
    return r.modifiedCount || 0;
  });

  // ── 4. Support tickets — retain the thread, scrub the person ──────────────
  // Tickets can be mid-conversation and may be evidence in a dispute, so the
  // subject and message survive; the identity attached to them does not.
  await run('supportTicketsAnonymised', async () => {
    const r = await SupportTicket.updateMany(
      { user: userId },
      { $set: { user: null, name: REDACTED, email: `deleted-${userId}@removed.invalid` } },
    );
    return r.modifiedCount || 0;
  });

  // ── 5. Break inbound references from OTHER users ──────────────────────────
  // A referrer's account is not deleted along with them, but it must stop
  // pointing at an id that no longer exists.
  await run('referredByCleared', async () => {
    const r = await User.updateMany(
      { referredBy: userId },
      { $set: { referredBy: null } },
    );
    return r.modifiedCount || 0;
  });

  // ── 6. Avatar file ────────────────────────────────────────────────────────
  // Object storage is outside Mongo, so nothing else would ever remove this.
  if (user?.avatarUrl) {
    await run('avatarDeleted', async () => {
      await deleteImage(user.avatarUrl);
      return 1;
    });
  }

  // ── 7. The user document — last, and only if everything else worked ───────
  //
  // The ordering alone is not enough. If an earlier step failed and the user
  // were deleted anyway, the retry would find nothing: the cron looks for users
  // whose deletionRequest is due, and there would no longer be a user. Whatever
  // failed to delete would be orphaned permanently — rows keyed to an id that
  // resolves to nobody, still holding the data the user asked to have erased.
  // That is precisely the compliance failure this whole feature exists to fix,
  // reintroduced by a partial success reported as a finished one.
  //
  // So a failed run leaves the account in place. The request stays in_progress,
  // the next scheduled run picks it up, and purgeUserData is idempotent so the
  // retry costs nothing.
  if (errors.length === 0) {
    await run('user', async () => {
      const r = await User.deleteOne({ _id: userId });
      return r.deletedCount || 0;
    });
  } else {
    console.warn(
      `[purgeUserData] Keeping user ${userId} — ${errors.length} step(s) failed, ` +
        'so the purge stays retryable rather than orphaning what is left.',
    );
  }

  return { deleted, errors };
}

// AdminActionLog is deliberately absent from this file. It records what admins
// did, not what the user did, and exists so those actions stay reviewable after
// the account is gone — removing it would erase the accountability trail along
// with the account.

// Every collection this purge touches, by name. Exported so the export builder
// can be tested against it: if one file grows a collection the other does not
// know about, one of them is wrong — an export that omits data hides what the
// user is entitled to see, and a purge that omits it leaves data behind after
// they asked for it gone. See exportUserData.js for the other half.
const PURGED_COLLECTIONS = [
  ...OWNED_BY_USER.map(([label]) => label),
  'referrals',
  'orders',
  'supportTickets',
];

module.exports = { purgeUserData, PURGED_COLLECTIONS, REDACTED };
