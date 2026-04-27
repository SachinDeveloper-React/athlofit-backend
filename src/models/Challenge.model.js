// src/models/Challenge.model.js
const mongoose = require('mongoose');

const challengeSchema = new mongoose.Schema(
  {
    title:       { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    emoji:       { type: String, default: '🏆' },
    color:       { type: String, default: '#0099FF' },

    // 'daily' resets every day; 'weekly' resets every Monday
    type: {
      type: String,
      enum: ['daily', 'weekly'],
      required: true,
    },

    // Visual grouping for the UI
    category: {
      type: String,
      enum: ['fitness', 'nutrition', 'hydration', 'wellness'],
      default: 'fitness',
    },

    // What metric to track
    criteriaType: {
      type: String,
      enum: [
        // Fitness
        'STEPS', 'CALORIES', 'ACTIVE_MINUTES', 'DISTANCE',
        // Hydration
        'HYDRATION',
        // Nutrition
        'MEALS_LOGGED', 'NUTRITION_CALORIES', 'NUTRITION_PROTEIN',
        'NUTRITION_DAYS',   // consecutive days logging meals
        'SPECIFIC_FOOD',    // log a specific food item N times
      ],
      required: true,
    },

    // For SPECIFIC_FOOD challenges — the food name to match
    targetFood: { type: String, default: null },

    targetValue: { type: Number, required: true, min: 1 },
    coinReward:  { type: Number, required: true, default: 50, min: 0 },

    isActive: { type: Boolean, default: true },
    order:    { type: Number, default: 0 },
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

challengeSchema.index({ type: 1, isActive: 1, order: 1 });
challengeSchema.index({ category: 1, isActive: 1 });

module.exports = mongoose.model('Challenge', challengeSchema);
