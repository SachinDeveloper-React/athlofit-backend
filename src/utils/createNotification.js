// src/utils/createNotification.js
//
// Single entry-point for all in-app notifications.
// Persists to MongoDB AND fires an FCM push — call this everywhere
// instead of calling sendPushToUser directly.

const mongoose = require('mongoose');
const Notification = require('../models/Notification.model');
const { sendPushToUser } = require('./pushNotification');

const MAX_PER_USER = 200;

/**
 * Create a persisted notification and send an FCM push.
 *
 * The count→find→delete sequence is wrapped in a MongoDB session/transaction
 * so the notification cap is enforced atomically under concurrent requests.
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
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // 1. Count existing notifications inside the transaction
    const count = await Notification.countDocuments({ user: userId }).session(session);

    // 2. If at or over the cap, delete the oldest to make room for the new one
    if (count >= MAX_PER_USER) {
      const oldest = await Notification.find({ user: userId })
        .sort({ createdAt: 1 })
        .limit(count - MAX_PER_USER + 1)
        .select('_id')
        .session(session);
      await Notification.deleteMany({ _id: { $in: oldest.map(n => n._id) } }).session(session);
    }

    // 3. Persist the new notification inside the same transaction
    await Notification.create([{ user: userId, type, title, message, data }], { session });

    await session.commitTransaction();

    // 4. Fire FCM push (non-blocking, outside the transaction)
    if (push) {
      sendPushToUser(userId, { title, body: message, data });
    }
  } catch (err) {
    await session.abortTransaction();
    console.warn('[createNotification] failed:', err.message);
  } finally {
    session.endSession();
  }
}

module.exports = { createNotification };
