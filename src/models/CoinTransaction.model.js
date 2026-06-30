// src/models/CoinTransaction.model.js
const mongoose = require('mongoose');

/**
 * CoinTransaction — persistent log of every coin earn/spend event.
 * Each record captures exactly what happened, when, and why.
 */
const coinTransactionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: ['EARNED', 'SPENT', 'REFUND'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    // Running balance AFTER this transaction was applied
    balanceAfter: {
      type: Number,
      default: 0,
    },
    // What triggered this transaction
    source: {
      type: String,
      required: true,
      enum: [
        'PASSIVE_STEPS',         // Earned from every 100 steps
        'DAILY_STEP_GOAL',       // Daily step goal reached (manual claim)
        'DAILY_STEP_GOAL_AUTO',  // Auto-awarded on health sync
        'HYDRATION_GOAL',        // Daily water goal
        'STREAK_BADGE',          // Streak milestone badge
        'ACHIEVEMENT',           // Advanced achievement claimed
        'CHALLENGE',             // Challenge completed
        'REFERRAL_BONUS',        // Referral bonus
        'SHOP_PURCHASE',         // Spent on shop
        'SHOP_REFUND',           // Refund from order cancellation
        'MANUAL',                // Admin/manual adjustment
      ],
    },
    // Human-readable description
    description: {
      type: String,
      required: true,
    },
    // Optional metadata for context
    metadata: {
      steps: Number,
      previousSteps: Number,
      stepDelta: Number,
      orderId: mongoose.Schema.Types.ObjectId,
      rewardId: String,
      achievementId: mongoose.Schema.Types.ObjectId,
      challengeId: mongoose.Schema.Types.ObjectId,
      badgeKey: String,
      periodKey: String,
      date: String,
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

// Index for fast paginated queries per user
coinTransactionSchema.index({ user: 1, createdAt: -1 });
// Index for filtering by source type
coinTransactionSchema.index({ user: 1, source: 1, createdAt: -1 });

module.exports = mongoose.model('CoinTransaction', coinTransactionSchema);
