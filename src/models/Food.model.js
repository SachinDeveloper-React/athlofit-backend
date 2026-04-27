// src/models/Food.model.js
// ─── Food catalog item (admin-seeded, read-only for users) ────────────────────

const mongoose = require('mongoose');

const foodSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Food name is required'],
      trim: true,
      maxlength: [120, 'Name cannot exceed 120 characters'],
    },
    description: {
      type: String,
      trim: true,
      default: null,
    },

    // ── Per-serving macros ────────────────────────────────────────────────────
    calories: { type: Number, required: true, min: 0 },   // kcal
    protein:  { type: Number, required: true, min: 0 },   // g
    carbs:    { type: Number, required: true, min: 0 },   // g
    fat:      { type: Number, required: true, min: 0 },   // g
    fiber:    { type: Number, default: null, min: 0 },    // g
    sugar:    { type: Number, default: null, min: 0 },    // g

    // ── Serving ───────────────────────────────────────────────────────────────
    servingSize: { type: Number, required: true, default: 100 },
    servingUnit: {
      type: String,
      enum: ['g', 'ml', 'serving', 'piece'],
      default: 'g',
    },

    // ── Classification ────────────────────────────────────────────────────────
    dietType: {
      type: String,
      enum: ['veg', 'non-veg', 'vegan'],
      required: true,
    },
    category: {
      type: String,
      enum: ['breakfast', 'lunch', 'dinner', 'snacks'],
      required: true,
    },

    // ── Optional media ────────────────────────────────────────────────────────
    imageUrl: { type: String, default: null },

    // ── Catalog visibility ────────────────────────────────────────────────────
    isActive: { type: Boolean, default: true },
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

// Full-text search index for name and description
foodSchema.index({ name: 'text', description: 'text' });
// Compound index for the most common filter combinations
foodSchema.index({ dietType: 1, category: 1, isActive: 1 });
foodSchema.index({ category: 1, isActive: 1 });

module.exports = mongoose.model('Food', foodSchema);
