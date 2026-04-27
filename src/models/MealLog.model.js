// src/models/MealLog.model.js
// ─── A single logged meal entry for a user on a given day ────────────────────

const mongoose = require('mongoose');

const mealLogSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // What meal of the day this belongs to
    mealType: {
      type: String,
      enum: ['breakfast', 'lunch', 'dinner', 'snacks'],
      required: true,
    },

    // YYYY-MM-DD — makes date-based queries fast & timezone-safe
    date: {
      type: String,
      required: true,
      index: true,
    },

    // Food info — duplicated from catalog so historical entries survive if the
    // Food document is ever edited or removed
    foodRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Food',
      default: null,   // null if manually entered
    },
    name:     { type: String, required: true, trim: true },
    calories: { type: Number, required: true, min: 0 },
    protein:  { type: Number, default: null, min: 0 },
    carbs:    { type: Number, default: null, min: 0 },
    fat:      { type: Number, default: null, min: 0 },

    // Serving details
    quantity: { type: Number, default: null },
    unit:     {
      type: String,
      enum: ['g', 'ml', 'serving', 'piece', null],
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
  }
);

// Compound index: the most common query is "all entries for user X on date Y"
mealLogSchema.index({ user: 1, date: 1, mealType: 1 });

module.exports = mongoose.model('MealLog', mealLogSchema);
