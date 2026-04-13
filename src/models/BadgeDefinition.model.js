// src/models/BadgeDefinition.model.js
const mongoose = require('mongoose');

/**
 * BadgeDefinition — admin-managed badge configuration.
 * Each document defines one badge tier (starter, consistent, finisher, elite, etc.)
 * The app reads these from the API instead of hardcoding badge metadata.
 */
const badgeDefinitionSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    rule: {
      type: String,
      required: true,
      trim: true,
    },
    emoji: {
      type: String,
      required: true,
      default: '🏅',
    },
    color: {
      type: String,
      required: true,
      default: '#6366f1',
      // Hex color code for badge card accent
    },
    threshold: {
      type: Number,
      required: true,
      min: 1,
      // Number of consecutive streak days required to unlock
    },
    coinReward: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      // Coins awarded when this badge is unlocked
    },
    order: {
      type: Number,
      required: true,
      default: 0,
      // Display sort order (ascending)
    },
    isActive: {
      type: Boolean,
      default: true,
      // Admin can disable a badge without deleting it
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

// Index for fast sorted queries
badgeDefinitionSchema.index({ order: 1, isActive: 1 });

module.exports = mongoose.model('BadgeDefinition', badgeDefinitionSchema);
