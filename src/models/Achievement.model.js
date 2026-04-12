// src/models/Achievement.model.js
const mongoose = require('mongoose');

const achievementSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
    },
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    reward: {
      type: Number,
      required: true,
      min: 0,
    },
    criteriaType: {
      type: String,
      required: true,
      enum: ['STEPS_TOTAL', 'STEPS_DAILY', 'WATER_TOTAL', 'ORDERS_COUNT'],
    },
    targetValue: {
      type: Number,
      required: true,
      min: 1,
    },
    icon: {
      type: String,
      default: 'Award',
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

module.exports = mongoose.model('Achievement', achievementSchema);
