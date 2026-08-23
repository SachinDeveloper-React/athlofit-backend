// src/models/Notification.model.js
const mongoose = require("mongoose");
const { ALL_TYPES } = require("../utils/notificationPrefs");

const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      // Derived from the shared category list rather than written out here.
      //
      // This enum used to be a separate hand-maintained copy, and it drifted:
      // STREAK, GENERAL and SUPPORT were in use across eight call sites while
      // none were valid values. Mongoose rejected every such write,
      // createNotification swallowed the error, and since the push is sent
      // after the create, no push went out either — streak notifications, the
      // account-ban notice and support replies were all silently dead.
      enum: ALL_TYPES,
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    // Deep-link data forwarded to the app (screen + params)
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    read: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        ret.id = ret._id;
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

module.exports = mongoose.model("Notification", notificationSchema);
