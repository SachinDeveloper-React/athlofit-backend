// src/models/HealthActivity.model.js
const mongoose = require('mongoose');

// Stores daily aggregated health snapshots sent from the mobile app
const healthActivitySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    date: {
      type: String, // "YYYY-MM-DD"
      required: true,
    },
    steps: { type: Number, default: 0 },
    distance: { type: Number, default: 0 },   // km
    calories: { type: Number, default: 0 },   // kcal
    activeMinutes: { type: Number, default: 0 },
    heartRate: { type: Number, default: 0 },  // avg bpm
    heartRateMin: { type: Number, default: 0 },
    heartRateMax: { type: Number, default: 0 },
    bloodPressureSystolic: { type: Number, default: 0 },
    bloodPressureDiastolic: { type: Number, default: 0 },
    hydration: { type: Number, default: 0 },   // ml
    sleepHours: { type: Number, default: 0 },
    bloodGlucose: { type: Number, default: 0 }, // mmol/L
    weight: { type: Number, default: 0 },        // kg
    goalMet: { type: Boolean, default: false },
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

// One record per user per day
healthActivitySchema.index({ user: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('HealthActivity', healthActivitySchema);
