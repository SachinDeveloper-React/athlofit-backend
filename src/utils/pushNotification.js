// src/utils/pushNotification.js
//
// Thin wrapper around Firebase Admin messaging.
// Import this anywhere in the backend to fire a push to a single user.

const admin = require('../config/firebase.admin');
const User  = require('../models/User.model');
const { isPushAllowed } = require('./notificationPrefs');

/**
 * Send a push notification to a single user.
 *
 * @param {string|ObjectId} userId
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {Record<string,string>} [opts.data]   — forwarded to app for deep linking
 * @param {string} [opts.type]                   — notification category, checked
 *        against the user's per-category preferences. Omit only for pushes that
 *        genuinely have no category.
 */
async function sendPushToUser(userId, { title, body, data = {}, type = null }) {
  try {
    const user = await User.findById(userId)
      .select('fcmToken notificationsEnabled notificationPrefs');
    if (!user?.fcmToken) return;

    // Master switch plus the per-category preference. `type` is optional so the
    // few callers that send an untyped push still work — an unknown type is
    // allowed through rather than blocked, so a newly added category is never
    // silently undeliverable.
    if (!isPushAllowed(user, type)) return;

    // Stringify all data values (FCM requirement)
    const stringData = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)]),
    );

    await admin.messaging().send({
      token: user.fcmToken,
      notification: { title, body },
      data: stringData,
      android: {
        priority: 'high',
        notification: { channelId: 'athlofit_push', sound: 'default' },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    });
  } catch (err) {
    // Stale token — clear it so we don't keep trying
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      await User.findByIdAndUpdate(userId, { $set: { fcmToken: null } });
    }
    console.warn('[Push] sendPushToUser failed:', err.message);
  }
}

module.exports = { sendPushToUser };
