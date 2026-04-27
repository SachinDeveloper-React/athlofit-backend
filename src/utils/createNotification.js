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
    // 1. Persist to DB
    await Notification.create({ user: userId, type, title, message, data });

    // 2. Cap at MAX_PER_USER — delete oldest beyond the limit
    const count = await Notification.countDocuments({ user: userId });
    if (count > MAX_PER_USER) {
      const oldest = await Notification.find({ user: userId })
        .sort({ createdAt: 1 })
        .limit(count - MAX_PER_USER)
        .select('_id');
      await Notification.deleteMany({ _id: { $in: oldest.map(n => n._id) } });
    }

    // 3. Fire FCM push (non-blocking)
    if (push) {
      sendPushToUser(userId, { title, body: message, data });
    }
  } catch (err) {
    console.warn('[createNotification] failed:', err.message);
  }
}

module.exports = { createNotification };
