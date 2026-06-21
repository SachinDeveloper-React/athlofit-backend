// src/services/inactivityCleanup.service.js
//
// Revokes sessions for users who haven't made any API call in a
// configurable number of days (default 30). Safety net for cases
// where FCM token check alone isn't enough.

const User = require('../models/User.model');
const RefreshToken = require('../models/RefreshToken.model');

const INACTIVITY_DAYS = Number(process.env.INACTIVITY_EXPIRY_DAYS) || 30;

/**
 * Find users whose lastActiveAt is older than the threshold,
 * bump their tokenVersion, and revoke their refresh tokens.
 */
async function cleanupInactiveSessions() {
  const threshold = new Date(Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000);

  const inactiveUsers = await User.find({
    lastActiveAt: { $lt: threshold },
  }).select('_id');

  if (inactiveUsers.length === 0) {
    console.log('[InactivityCleanup] No inactive users found.');
    return { expired: 0 };
  }

  const userIds = inactiveUsers.map((u) => u._id);

  const result = await RefreshToken.updateMany(
    { user: { $in: userIds }, revoked: false },
    { $set: { revoked: true } },
  );

  await User.updateMany(
    { _id: { $in: userIds } },
    { $inc: { tokenVersion: 1 } },
  );

  console.log(
    `[InactivityCleanup] Revoked sessions for ${userIds.length} inactive users (${result.modifiedCount} tokens revoked).`,
  );

  return {
    expired: userIds.length,
    tokensRevoked: result.modifiedCount,
  };
}

module.exports = { cleanupInactiveSessions };
