// src/models/NutritionPreference.model.js
// ─── Per-user nutrition preferences (diet type, goal, calorie target) ─────────

const mongoose = require('mongoose');

const nutritionPreferenceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,   // one record per user
    },

    // 'veg' | 'non-veg' | 'vegan'
    dietPreference: {
      type: String,
      enum: ['veg', 'non-veg', 'vegan'],
      default: 'non-veg',
    },

    // 'weight_loss' | 'muscle_gain' | 'maintenance' | 'endurance'
    dietaryGoal: {
      type: String,
      enum: ['weight_loss', 'muscle_gain', 'maintenance', 'endurance'],
      default: 'maintenance',
    },

    // Daily calorie target in kcal
    calorieGoal: {
      type: Number,
      default: 2000,
      min: 500,
      max: 10000,
    },

    // Favourited food IDs
    favourites: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Food',
      },
    ],
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

module.exports = mongoose.model('NutritionPreference', nutritionPreferenceSchema);
