// src/models/Notification.model.js
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['GOAL', 'HYDRATION', 'PRODUCT', 'SECURITY', 'HEART', 'CHALLENGE', 'COIN'],
      required: true,
    },
    title:   { type: String, required: true },
    message: { type: String, required: true },
    // Deep-link data forwarded to the app (screen + params)
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    read: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        ret.id        = ret._id;
        ret.createdAt = new Date(ret.createdAt).getTime(); // ms timestamp for frontend
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Keep only the latest 200 notifications per user (TTL-style cap via pre-save hook)
notificationSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
