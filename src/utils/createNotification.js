// src/utils/createNotification.js
//
// Single entry-point for all in-app notifications.
// Persists to MongoDB AND fires an FCM push — call this everywhere
// instead of calling sendPushToUser directly.

const Notification = require('../models/Notification.model');
const { sendPushToUser } = require('./pushNotification');

const MAX_PER_USER = 200;

/**
 * Create a persisted notification and send an FCM push.
 *
 * Note: the count→trim→create sequence is NOT wrapped in a transaction so it
 * works on standalone MongoDB (transactions require a replica set). The cap is
 * enforced best-effort — a rare concurrent race may briefly leave one extra
 * notification, which is harmless and self-corrects on the next write.
 *
 * @param {string|ObjectId} userId
 * @param {object} opts
 * @param {'GOAL'|'HYDRATION'|'PRODUCT'|'SECURITY'|'HEART'|'CHALLENGE'|'COIN'} opts.type
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {Record<string,string>} [opts.data]   — deep-link payload { screen, params }
 * @param {boolean} [opts.push=true]            — set false to skip FCM push
 */
async function createNotification(userId, { type, title, message, data = {}, push = true }) {
  try {
    // 1. Count existing notifications for this user
    const count = await Notification.countDocuments({ user: userId });

    // 2. If at or over the cap, delete the oldest to make room for the new one
    if (count >= MAX_PER_USER) {
      const oldest = await Notification.find({ user: userId })
        .sort({ createdAt: 1 })
        .limit(count - MAX_PER_USER + 1)
        .select('_id');
      await Notification.deleteMany({ _id: { $in: oldest.map((n) => n._id) } });
    }

    // 3. Persist the new notification
    await Notification.create({ user: userId, type, title, message, data });

    // 4. Fire FCM push (non-blocking)
    if (push) {
      sendPushToUser(userId, { title, body: message, data });
    }
  } catch (err) {
    console.warn('[createNotification] failed:', err.message);
  }
}

module.exports = { createNotification };
