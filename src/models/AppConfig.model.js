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
      unverifiedDailyCap: { type: Number, default: 50 }, // max coins/day for unverified users
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
            _id: false,
            value: { type: String, required: true },
            label: { type: String, required: true },
            emoji: { type: String, default: '' },
          },
        ],
        default: [
          { value: 'all',     label: 'All',        emoji: '🍽️' },
          { value: 'veg',     label: 'Vegetarian', emoji: '🥦' },
          { value: 'non-veg', label: 'Non-Veg',    emoji: '🍗' },
          { value: 'vegan',   label: 'Vegan',       emoji: '🌱' },
        ],
      },
      dietaryGoals: {
        type: [
          {
            _id: false,
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
            _id: false,
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
      phone:   { type: String, default: '+91 98765 43210' },
      address: { type: String, default: 'Bengaluru, Karnataka, India' },
    },

    // ── Dynamic app store / download links shown on the website ──────────────
    appLinks: {
      playStore:   { type: String, default: '' },
      appStore:    { type: String, default: '' },
      // Optional universal/deep link for "Open App" buttons
      universal:   { type: String, default: '' },
      // Toggle visibility of download buttons on the website
      showBadges:  { type: Boolean, default: true },
    },

    // ── Social media handles (rendered in footer / structured data) ──────────
    social: {
      instagram: { type: String, default: '' },
      twitter:   { type: String, default: '' },
      facebook:  { type: String, default: '' },
      youtube:   { type: String, default: '' },
      linkedin:  { type: String, default: '' },
    },

    // ── Website-level SEO + payment settings ─────────────────────────────────
    website: {
      siteName:        { type: String, default: 'Athlofit' },
      defaultMetaTitle:{ type: String, default: 'Athlofit — Walk. Earn. Shop.' },
      defaultMetaDescription: {
        type: String,
        default: 'Track your fitness, earn coins by walking, and shop premium health products.',
      },
      ogImage:         { type: String, default: '' },
      logoUrl:         { type: String, default: '' },
      razorpayEnabled: { type: Boolean, default: false },
    },

    coin_config: {
      steps: {
        rate_per_100_steps: { type: Number, default: 0.5 },
      },
      rewards: {
        daily_step_goal_reached: {
          enabled:    { type: Boolean, default: true },
          coin_value: { type: Number, default: 50 },
        },
      },
    },

    // ─── Streak protection settings (admin-controlled) ───────────────────────
    streak: {
      // Freeze: earned every N consecutive streak days (milestone).
      freezeEarnEvery:  { type: Number, default: 7 },
      // Max freezes a user can store at any time.
      maxFreezes:       { type: Number, default: 2 },
      // Freeze grace period (hours). Default 24 = 1 missed day is forgiven.
      freezeGraceHours: { type: Number, default: 24 },
      // Weekly life: earn 1 life every 7 calendar days.
      lifeEarnIntervalDays: { type: Number, default: 7 },
      // Max lives a user can store.
      maxLives:         { type: Number, default: 2 },
      // Coin cost to restore a broken streak (manual restore option).
      restoreCostCoins: { type: Number, default: 100 },
      // Time window (hours) in which restore is allowed after a break.
      restoreWindowHours: { type: Number, default: 48 },
    },

    // ─── Notification templates (admin-editable) ──────────────────────────────
    // Variables: {{orderId}}, {{coins}}, {{streak}}, {{goal}}, {{name}}, {{badge}}
    notifications: {
      orderConfirmed: {
        title: { type: String, default: '🛍️ Order Confirmed!' },
        message: { type: String, default: 'Your order #{{orderId}} has been placed successfully.' },
      },
      orderCancelled: {
        title: { type: String, default: '❌ Order Cancelled' },
        message: { type: String, default: 'Order #{{orderId}} cancelled. {{coins}} coins refunded.' },
      },
      stepGoalReached: {
        title: { type: String, default: '🎯 Daily Step Goal Reached!' },
        message: { type: String, default: 'You hit your {{goal}} step goal and earned {{coins}} coins!' },
      },
      rewardClaimed: {
        title: { type: String, default: '🪙 Reward Claimed!' },
        message: { type: String, default: 'You claimed {{coins}} coins for "{{name}}"!' },
      },
      achievementUnlocked: {
        title: { type: String, default: '🏆 Achievement Unlocked!' },
        message: { type: String, default: 'You unlocked "{{name}}" and earned {{coins}} coins!' },
      },
      badgeUnlocked: {
        title: { type: String, default: '{{badge}} Badge Unlocked!' },
        message: { type: String, default: 'Congrats! You unlocked the {{name}} badge.' },
      },
      streakBroken: {
        title: { type: String, default: "💪 Start fresh!" },
        message: { type: String, default: 'Your streak ended, but every step counts. Start a new one today!' },
      },
      streakFrozen: {
        title: { type: String, default: '🧊 Streak Frozen!' },
        message: { type: String, default: 'Your streak freeze kicked in! Get moving today.' },
      },
      streakLifeUsed: {
        title: { type: String, default: '🩹 Streak Saved!' },
        message: { type: String, default: 'A streak life was used. Walk today to keep it going!' },
      },
      streakRestored: {
        title: { type: String, default: '🔥 Streak Restored!' },
        message: { type: String, default: 'Your {{streak}}-day streak is back! Keep it going.' },
      },
      challengeComplete: {
        title: { type: String, default: '🎉 Challenge Complete!' },
        message: { type: String, default: 'You completed "{{name}}" and earned {{coins}} coins!' },
      },
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
