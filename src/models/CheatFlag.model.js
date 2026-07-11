// src/models/CheatFlag.model.js
//
// Records each instance where a user's step submission was flagged as
// suspicious by the anti-cheat validation (stepValidation.js).
// Used to enforce the penalty rule: 3+ flags in a single day => coin block for 10 days.
//
// NOTE: Only device-originated step cheats are recorded here.
// Bonus steps (admin/agent credited) are excluded.

const mongoose = require('mongoose');

const cheatFlagSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    date: {
      type: String, // "YYYY-MM-DD" — the day the flag occurred
      required: true,
    },
    reason: {
      type: String, // reason from stepValidation (e.g., "Rate too high: 500 steps/min...")
      required: true,
    },
    incomingSteps: {
      type: Number, // what the client sent
      default: 0,
    },
    clampedSteps: {
      type: Number, // what we accepted after clamping
      default: 0,
    },
    existingSteps: {
      type: Number, // what was already stored
      default: 0,
    },
    // Whether this flag triggered the 10-day block penalty
    triggeredBlock: {
      type: Boolean,
      default: false,
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
  }
);

// Index for quick lookup: "how many flags does this user have today?"
cheatFlagSchema.index({ user: 1, date: 1 });

// Index for admin queries: all flags for a user
cheatFlagSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('CheatFlag', cheatFlagSchema);
