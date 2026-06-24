// src/models/AdminActionLog.model.js
// ─── Audit log of admin actions taken on users (ban, coins, role, etc.) ──────

const mongoose = require('mongoose');

const adminActionLogSchema = new mongoose.Schema(
  {
    // The admin who performed the action
    admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    adminName: { type: String, default: '' },

    // The target user the action was performed on
    targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    action: {
      type: String,
      required: true,
      enum: [
        'BAN', 'UNBAN', 'ROLE_CHANGE', 'COIN_CREDIT', 'COIN_DEBIT',
        'STREAK_RESET', 'ACCOUNT_EDIT', 'SESSION_REVOKE', 'SESSION_REVOKE_ALL',
        'DELETE',
      ],
    },
    // Free-text reason / description for the action
    reason: { type: String, default: '' },
    // Optional structured before/after or detail payload
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  },
);

adminActionLogSchema.index({ targetUser: 1, createdAt: -1 });

module.exports = mongoose.model('AdminActionLog', adminActionLogSchema);
