// src/utils/exportUserData.js
//
// Assembles everything the platform holds about one user, for the
// "download my data" request that the Play Store data policy and India's DPDP
// Act both require and that the app could not previously answer.
//
// ── Kept deliberately symmetric with purgeUserData.js ───────────────────────
//
// Export and deletion are the same question asked two ways: what does this
// system hold about me? If the two data maps drift, one of them is wrong — an
// export that omits a collection hides data the user is entitled to see, and a
// purge that omits one leaves data behind after they asked for it gone. The
// collection list here is written in the same order as the purge, so the two
// files can be read side by side.
//
// Two categories are treated differently and both are justified below:
// credentials, which are not user data and must never leave the server, and
// anti-cheat detail, which describes the detection rules rather than the user.

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
const CheatFlag = require('../models/CheatFlag.model');
const BonusSteps = require('../models/BonusSteps.model');
const Referral = require('../models/Referral.model');
const Order = require('../models/Order.model');
const SupportTicket = require('../models/SupportTicket.model');

// Fields on the User document that are credentials or server-side bookkeeping,
// not personal data. `select('-x')` in the query is not enough on its own —
// this list is the explicit statement of what must never reach the file.
//
// RefreshToken is absent from the collection list below for the same reason:
// a session token is a key to the account, and writing live keys into a file
// the user then emails to themselves would be handing out their own account.
const USER_SECRET_FIELDS = [
  '-password',
  '-otp',
  '-otpExpires',
  '-otpFlow',
  '-tokenVersion',
  '-fcmToken',
  '-__v',
  // Which staff member took an action on the account. The fact of a ban or a
  // step-tracking pause belongs in the export — it is about the user, and they
  // are entitled to know it happened — but WHO did it is about an employee, not
  // about them, and identifying staff to the person they moderated is how
  // moderators get targeted. The reason and the timestamps are still included.
  '-banInfo.bannedBy',
  '-stepsTracking.disabledBy',
  '-stepsTracking.enabledBy',
  '-syncDebug.enabledBy',
].join(' ');

/**
 * Build the complete export payload.
 *
 * `.lean()` throughout: these are read-only snapshots being serialised straight
 * to JSON, so hydrating full Mongoose documents would cost memory and time for
 * nothing. A heavy user's export is the one case where that matters.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<object|null>} null when the user does not exist
 */
async function exportUserData(userId) {
  const user = await User.findById(userId).select(USER_SECRET_FIELDS).lean();
  if (!user) return null;

  const [
    healthActivity,
    bmiRecords,
    mealLogs,
    nutritionPreferences,
    searchLogs,
    coinTransactions,
    gamification,
    userChallenges,
    notifications,
    cheatFlags,
    bonusSteps,
    referrals,
    orders,
    supportTickets,
  ] = await Promise.all([
    HealthActivity.find({ user: userId }).sort({ date: 1 }).lean(),
    BmiRecord.find({ user: userId }).sort({ createdAt: 1 }).lean(),
    MealLog.find({ user: userId }).sort({ createdAt: 1 }).lean(),
    NutritionPreference.find({ user: userId }).lean(),
    SearchLog.find({ user: userId }).sort({ createdAt: 1 }).lean(),
    CoinTransaction.find({ user: userId }).sort({ createdAt: 1 }).lean(),
    Gamification.findOne({ user: userId }).lean(),
    UserChallenge.find({ user: userId }).sort({ createdAt: 1 }).lean(),
    Notification.find({ user: userId }).sort({ createdAt: 1 }).lean(),
    CheatFlag.find({ user: userId }).sort({ createdAt: 1 }).lean(),
    BonusSteps.find({ user: userId }).sort({ createdAt: 1 }).lean(),
    Referral.find({ $or: [{ referrer: userId }, { referee: userId }] }).lean(),
    Order.find({ user: userId }).sort({ createdAt: 1 }).lean(),
    SupportTicket.find({ user: userId }).sort({ createdAt: 1 }).lean(),
  ]);

  return {
    // ── Metadata, so the file is self-describing months later ───────────────
    export: {
      generatedAt: new Date().toISOString(),
      userId: String(user._id),
      format: 'athlofit-data-export-v1',
      notes: [
        'Session tokens and password data are excluded — they are account credentials, not personal data.',
        'Anti-cheat entries list the date and outcome only; the detection rules themselves are not included.',
      ],
    },

    profile: user,
    // Split out of `profile` for readability: it is an append-only trail rather
    // than a property of the person, and it can be long.
    deviceHistory: user.deviceHistory || [],

    // ── Health & activity ───────────────────────────────────────────────────
    healthActivity,
    bmiRecords,
    mealLogs,
    nutritionPreferences,
    searchLogs,

    // ── Rewards ─────────────────────────────────────────────────────────────
    gamification,
    coinTransactions,
    userChallenges,
    bonusSteps,

    // ── Communications & commerce ───────────────────────────────────────────
    notifications,
    orders,
    supportTickets,
    referrals,

    // ── Anti-cheat ──────────────────────────────────────────────────────────
    //
    // Included because a record about the user is theirs to see, and being
    // flagged can cost them coins — they are entitled to know it happened.
    //
    // The `reason` string is NOT included. It spells out the thresholds that
    // triggered detection ("Rate too high: 500 steps/min…"), which is a
    // description of the anti-cheat system rather than of the user, and handing
    // it over is handing anyone who asks a map for tuning around it. Date,
    // counts and outcome carry the part that is actually about them.
    antiCheatFlags: cheatFlags.map((f) => ({
      date: f.date,
      incomingSteps: f.incomingSteps,
      clampedSteps: f.clampedSteps,
      existingSteps: f.existingSteps,
      triggeredBlock: f.triggeredBlock,
      createdAt: f.createdAt,
    })),

    // Row counts up front, so a user (or a regulator) can see the shape of the
    // file without parsing all of it, and so an empty section is visibly empty
    // rather than ambiguous.
    counts: {
      healthActivity: healthActivity.length,
      bmiRecords: bmiRecords.length,
      mealLogs: mealLogs.length,
      searchLogs: searchLogs.length,
      coinTransactions: coinTransactions.length,
      userChallenges: userChallenges.length,
      notifications: notifications.length,
      orders: orders.length,
      supportTickets: supportTickets.length,
      referrals: referrals.length,
      bonusSteps: bonusSteps.length,
      antiCheatFlags: cheatFlags.length,
    },
  };
}

// The collections this export covers, named to match purgeUserData's manifest
// so the two can be compared in a test rather than by eye.
const EXPORTED_COLLECTIONS = [
  'healthActivity',
  'bmiRecords',
  'mealLogs',
  'nutritionPreferences',
  'searchLogs',
  'coinTransactions',
  'gamification',
  'userChallenges',
  'notifications',
  'cheatFlags',
  'bonusSteps',
  'referrals',
  'orders',
  'supportTickets',
];

// Purged but deliberately NOT exported, with the reason. Anything appearing
// here is a decision; anything missing from both lists is a bug.
const EXCLUDED_FROM_EXPORT = {
  // Live session keys. Handing a user their own refresh tokens in a file they
  // may email or store is handing out access to the account.
  refreshTokens: 'credentials, not personal data',
};

module.exports = {
  exportUserData,
  EXPORTED_COLLECTIONS,
  EXCLUDED_FROM_EXPORT,
  USER_SECRET_FIELDS,
};
