// src/models/BmiRecord.model.js
// ─── Stores individual BMI readings for a user (full history) ─────────────────

const mongoose = require('mongoose');

const bmiRecordSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // YYYY-MM-DD — used for sorting/display
    date: {
      type: String,
      required: true,
      index: true,
    },
    weight:   { type: Number, required: true, min: 1 },    // kg
    height:   { type: Number, required: true, min: 0.5 },  // m
    bmi:      { type: Number, required: true, min: 1 },
    category: {
      type: String,
      enum: ['underweight', 'normal', 'overweight', 'obese'],
      required: true,
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

// Index for fetching a user's history newest-first
bmiRecordSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('BmiRecord', bmiRecordSchema);
