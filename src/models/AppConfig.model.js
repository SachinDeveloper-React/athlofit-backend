// src/models/AppConfig.model.js
// ─── Single-document store for all runtime app configuration ─────────────────
// Only one document should exist (key: 'global'). Use upsert to update it.

const mongoose = require('mongoose');

const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true, index: true },

    coin: {
      conversionRate:  { type: Number, default: 10 },   // coins per ₹1
      dailyEarnLimit:  { type: Number, default: 10 },   // max passive coins/day from steps
      maxDailyRewards: { type: Number, default: 250 },  // max claimable coins/day
      coinsPerStepKm:  { type: Number, default: 1 },
      purchaseEnabled: { type: Boolean, default: true },
      referrerBonus:   { type: Number, default: 200 },  // coins to referrer
      refereeBonus:    { type: Number, default: 100 },   // coins to new user
    },

    steps: {
      defaultDailyGoal: { type: Number, default: 8000 },
      maxDailyGoal:     { type: Number, default: 30000 },
    },

    rewards: {
      stepGoalCoins:      { type: Number, default: 50 },   // daily step goal reward
      hydrationGoalCoins: { type: Number, default: 20 },   // daily water goal reward
      hydrationGoalMl:    { type: Number, default: 2000 }, // water threshold in ml
    },

    features: {
      shopEnabled:              { type: Boolean, default: true },
      ordersEnabled:            { type: Boolean, default: true },
      healthAnalyticsEnabled:   { type: Boolean, default: true },
      referralEnabled:          { type: Boolean, default: true },
      leaderboardEnabled:       { type: Boolean, default: true },
    },

    nutrition: {
      dietPreferences: {
        type: [
          {
            value: { type: String, required: true },
            label: { type: String, required: true },
            emoji: { type: String, default: '' },
          },
        ],
        default: [
          { value: 'veg',     label: 'Vegetarian', emoji: '🥦' },
          { value: 'non-veg', label: 'Non-Veg',    emoji: '🍗' },
          { value: 'vegan',   label: 'Vegan',       emoji: '🌱' },
        ],
      },
      dietaryGoals: {
        type: [
          {
            value: { type: String, required: true },
            label: { type: String, required: true },
            emoji: { type: String, default: '' },
          },
        ],
        default: [
          { value: 'weight_loss', label: 'Weight Loss', emoji: '🔥' },
          { value: 'muscle_gain', label: 'Muscle Gain', emoji: '💪' },
          { value: 'maintenance', label: 'Maintenance', emoji: '⚖️' },
          { value: 'endurance',   label: 'Endurance',   emoji: '🏃' },
        ],
      },
      catalogFilters: {
        type: [
          {
            id:    { type: String, required: true },
            label: { type: String, required: true },
            emoji: { type: String, default: '' },
          },
        ],
        default: [
          { id: 'all',        label: 'All',        emoji: '🍽️' },
          { id: 'veg',        label: 'Veg',        emoji: '🥦' },
          { id: 'non-veg',    label: 'Non-Veg',    emoji: '🍗' },
          { id: 'vegan',      label: 'Vegan',       emoji: '🌱' },
          { id: 'favourites', label: 'Favourites', emoji: '❤️' },
        ],
      },
    },

    maintenance: {
      enabled: { type: Boolean, default: false },
      message: { type: String, default: 'We are under maintenance. Back soon!' },
    },

    support: {
      email:   { type: String, default: 'support@athlofit.com' },
      website: { type: String, default: 'www.athlofit.com/faq' },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        delete ret.key;
        return ret;
      },
    },
  },
);

module.exports = mongoose.model('AppConfig', appConfigSchema);
