// src/models/SearchLog.model.js
// ─── Captures every food search query and result-click event ─────────────────
//
// Two event types are stored in the same collection:
//   type: 'query'  — user typed a search term
//   type: 'click'  — user tapped a food card from search results
//
// The `meta` object is intentionally open-ended so callers can attach any
// additional fields without a schema migration (e.g. screen, sessionId, ab_variant).

const mongoose = require('mongoose');

const searchLogSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // 'query' | 'click'
    type: {
      type: String,
      enum: ['query', 'click'],
      required: true,
    },

    // The raw text the user typed (always present)
    query: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    // Resolved / normalised query after synonym mapping (may equal `query`)
    resolvedQuery: {
      type: String,
      trim: true,
      default: null,
    },

    // ── Click-specific fields (null for type='query') ─────────────────────────
    clickedFoodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Food',
      default: null,
    },
    clickedFoodName: {
      type: String,
      default: null,
    },
    // Position of the clicked item in the result list (0-indexed)
    resultPosition: {
      type: Number,
      default: null,
    },

    // ── Extensible metadata bag ───────────────────────────────────────────────
    // Callers can pass any extra key-value pairs here without schema changes.
    // Examples: { screen: 'FoodCatalog', sessionId: '...', ab_variant: 'B' }
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,   // createdAt = the event timestamp
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Fast look-ups by user + time range (analytics queries)
searchLogSchema.index({ user: 1, createdAt: -1 });
// Aggregate popular queries across all users
searchLogSchema.index({ query: 1, type: 1 });

module.exports = mongoose.model('SearchLog', searchLogSchema);
