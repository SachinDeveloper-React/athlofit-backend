// src/models/BonusSteps.model.js
// ─── Tracks bonus steps credited to a user by admin/system ───────────────────

const mongoose = require('mongoose');

const bonusStepsSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Number of bonus steps credited
    steps: {
      type: Number,
      required: true,
      min: [1, 'Steps must be at least 1'],
    },
    // The date (YYYY-MM-DD) the bonus steps apply to
    date: {
      type: String,
      required: true,
    },
    // Reason shown to the user in their step history
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: [200, 'Reason cannot exceed 200 characters'],
    },
    // Who added the steps
    source: {
      type: String,
      enum: ['admin', 'system', 'reward', 'challenge'],
      default: 'admin',
    },
    // Admin who credited the steps (null for system-generated)
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
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

// Compound index for quick lookups: "all bonus steps for user X on date Y"
bonusStepsSchema.index({ user: 1, date: 1 });
// Index for user history (sorted by date descending)
bonusStepsSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('BonusSteps', bonusStepsSchema);
