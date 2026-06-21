// src/services/uninstallDetection.service.js
//
// Periodically sends silent FCM push notifications to all users with
// active tokens. If a token is invalid (app uninstalled), clears it
// and revokes the user's sessions so they must re-login.

const admin = require('../config/firebase.admin');
const User = require('../models/User.model');
const RefreshToken = require('../models/RefreshToken.model');

const BATCH_SIZE = 500;

/**
 * Send a silent data-only message to verify each user's FCM token.
 * Invalid tokens → app was uninstalled → revoke sessions.
 */
async function detectUninstalledUsers() {
  const users = await User.find({
    fcmToken: { $ne: null },
  }).select('_id fcmToken');

  if (users.length === 0) {
    console.log('[UninstallDetection] No users with active FCM tokens to check.');
    return { checked: 0, uninstalled: 0 };
  }

  console.log(`[UninstallDetection] Checking ${users.length} users...`);

  const uninstalledUserIds = [];

  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);

    const messages = batch.map((user) => ({
      token: user.fcmToken,
      data: { type: 'heartbeat', timestamp: String(Date.now()) },
      android: { priority: 'normal' },
      apns: {
        headers: { 'apns-priority': '5' },
        payload: { aps: { 'content-available': 1 } },
      },
    }));

    const response = await admin.messaging().sendEach(messages);

    response.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = r.error?.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          uninstalledUserIds.push(batch[idx]._id);
        }
      }
    });
  }

  if (uninstalledUserIds.length > 0) {
    // Clear FCM tokens and revoke sessions
    await User.updateMany(
      { _id: { $in: uninstalledUserIds } },
      { $set: { fcmToken: null }, $inc: { tokenVersion: 1 } },
    );

    await RefreshToken.updateMany(
      { user: { $in: uninstalledUserIds }, revoked: false },
      { $set: { revoked: true } },
    );

    console.log(
      `[UninstallDetection] Detected ${uninstalledUserIds.length} uninstalled users. Sessions revoked.`,
    );
  }

  return {
    checked: users.length,
    uninstalled: uninstalledUserIds.length,
  };
}

module.exports = { detectUninstalledUsers };
