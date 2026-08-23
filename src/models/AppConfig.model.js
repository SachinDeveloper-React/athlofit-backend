// src/models/AppConfig.model.js
// ─── Single-document store for all runtime app configuration ─────────────────
// Only one document should exist (key: 'global'). Use upsert to update it.

const mongoose = require('mongoose');

const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true, index: true },

    coin: {
      conversionRate:  { type: Number, default: 10 },   // coins per ₹1
      dailyEarnLimit:  { type: Number, default: 200 },  // max passive coins/day from steps
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
      // Whether an implausible step submission actually PUNISHES the user —
      // warning notifications and the 10-day coin block in cheatPenalty.js.
      //
      // Default false, deliberately. The penalty system was switched off wholesale
      // because it was firing on honest users, and while the signal driving it is
      // now much narrower (severity 'implausible' only, never mere clamping), that
      // is an argument for being able to turn it on — not for turning it on by
      // itself. Flags are recorded either way, so leaving this false collects the
      // evidence without anyone being blocked on a theory.
      cheatPenaltyEnabled:      { type: Boolean, default: false },
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
      email:    { type: String, default: 'support@athlofit.com' },
      website:  { type: String, default: 'www.athlofit.com/faq' },
      phone:    { type: String, default: '+91 98765 43210' },
      address:  { type: String, default: 'Bengaluru, Karnataka, India' },
      whatsapp: { type: String, default: '919310777797' },
      whatsappMessage: { type: String, default: 'Hello, I need support with Athlofit app' },
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

    // ─── Force Update / Version Control ─────────────────────────────────────────
    // Backend-driven app version gating. When the installed app version is below
    // the configured minimum, the client shows an update modal.
    forceUpdate: {
      // Minimum version the user MUST install (hard block — no dismiss).
      android: {
        minVersion:    { type: String, default: '0.0.1' },
        latestVersion: { type: String, default: '0.0.1' },
        updateUrl:     { type: String, default: '' },
      },
      ios: {
        minVersion:    { type: String, default: '0.0.1' },
        latestVersion: { type: String, default: '0.0.1' },
        updateUrl:     { type: String, default: '' },
      },
      // 'force' = mandatory (can't dismiss), 'soft' = optional (user can skip)
      // This is determined dynamically: if app version < minVersion → force,
      // if app version >= minVersion but < latestVersion → soft.
      // Custom message shown in the update modal.
      title:   { type: String, default: 'Update Available' },
      message: { type: String, default: 'A new version of Athlofit is available. Please update for the best experience.' },
      // Toggle to enable/disable the version check entirely
      enabled: { type: Boolean, default: true },
    },

    // ─── Build-level step-sync gate ──────────────────────────────────────────
    //
    // The per-user switch (User.stepsTracking) pauses one account. This pauses
    // one BUILD, across everyone running it.
    //
    // That is the shape the real incident had: a released version with a step
    // counting bug inflating totals on every device it was installed on.
    // Switching users off one at a time is not a response to that, and shipping
    // another release does not help either — a Play Store rollout is gradual
    // and users update whenever they feel like it, so the bad build keeps
    // submitting for weeks. This stops it server-side, immediately, with no
    // release involved.
    //
    // Inert by default: `enabled` false and no versions listed, so nothing
    // changes until someone deliberately blocks a build.
    stepSync: {
      enabled: { type: Boolean, default: false },
      // Exact app versions barred from submitting steps, e.g. ['1.72'].
      // Exact-match rather than a range because the usual case is one known-bad
      // build with good builds on either side of it.
      blockedVersions: { type: [String], default: [] },
      // Everything BELOW this version is barred. Empty string disables the
      // check. Use when a bug spans every build up to a fix, rather than one.
      minVersion: { type: String, default: '' },
      // Whether clients that send no version header at all are barred.
      //
      // Default false, and that default matters: every build released before
      // version headers existed sends nothing, so turning this on blocks all of
      // them. It is here for the case where the bad build is a pre-telemetry
      // one and there is no other way to identify it — a deliberate, informed
      // choice, never a default.
      blockUnknownVersion: { type: Boolean, default: false },
      // Shown to the user in place of their step count. Should tell them to
      // update, since that is the only thing that will clear it.
      message: {
        type: String,
        default:
          'Step tracking is paused on this version of the app. Please update to the latest version to continue earning.',
      },
    },

    // ─── Streak protection settings (admin-controlled) ───────────────────────
    streak: {
      // ── Whether reaching a streak milestone pays its coin reward ──────────
      //
      // Off by default, deliberately. Streak badges have never actually paid
      // out (awardBadges marked them unlocked and claimReward read that same
      // flag as "already claimed"), so switching payouts on at the same time as
      // the fix would hand the entire existing user base a backlog worth up to
      // 25,400 coins each.
      //
      // Turning this ON later does NOT open that backlog. Payout eligibility is
      // stamped onto each badge AT UNLOCK TIME from this flag, so a badge
      // earned while payouts were off stays unpayable forever — only milestones
      // reached after the switch is flipped are worth coins. That is what makes
      // enabling it a safe, forward-only decision rather than an instant
      // liability.
      badgeCoinsEnabled: { type: Boolean, default: false },

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
