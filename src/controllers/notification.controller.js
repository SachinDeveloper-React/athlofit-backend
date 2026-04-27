// src/controllers/notification.controller.js
//
// Admin-only endpoint to send rich FCM push notifications.
// Supports all targeting modes + deep linking + images.

const admin    = require('../config/firebase.admin');
const User     = require('../models/User.model');
const Gamification = require('../models/Gamification.model');
const Notification = require('../models/Notification.model');
const { success, error } = require('../utils/response');

// ─── Valid deep-link screens (must match frontend routes.ts exactly) ──────────
const VALID_SCREENS = [
  'Tracker', 'Shop', 'Account',
  'TrackerScreen', 'StepsScreen', 'CaloriesScreen', 'HeartRateScreen',
  'BloodPressureScreen', 'HydrationScreen', 'HealthAnalyticsScreen',
  'StreakScreen', 'CoinsScreen', 'LeaderboardScreen',
  'ChallengesScreen', 'ChallengeDetailScreen',
  'FoodCatalogScreen', 'FoodDetailScreen', 'BmiCalculatorScreen',
  'ShopScreen', 'ShopSearchScreen', 'ProductDetailScreen',
  'CartScreen', 'CheckoutScreen', 'OrderHistoryScreen',
  'AddressesScreen', 'AddEditAddressScreen',
  'AccountScreen', 'SettingsScreen', 'EditProfileScreen',
  'NotificationsScreen', 'PrivacyScreen', 'TermsScreen',
  'HelpSupportScreen', 'AchievementsScreen', 'ReferralScreen',
];

// ─── Targeting modes ──────────────────────────────────────────────────────────
const VALID_TARGETS = [
  'all',           // everyone with a token
  'ios',           // iOS devices only
  'android',       // Android devices only
  'user',          // single user by userId
  'users',         // specific list of userIds
  'streak',        // users with streakDays >= streakMin (and optionally <= streakMax)
  'coins',         // users with coinsBalance >= coinsMin
  'gender',        // users matching gender (M / F / O)
  'profileComplete', // users who have completed profile
  'newUsers',      // users registered within last N days
  'provider',      // users by auth provider: email | google | apple
];

// ─── Resolve target user docs based on `target` + filter fields ───────────────
async function resolveTargets(body) {
  const {
    target = 'all',
    userId,
    userIds,
    // streak filter
    streakMin,
    streakMax,
    // coins filter
    coinsMin,
    // demographic filters
    gender,
    provider,
    // profile filter
    profileComplete,
    // new users filter
    registeredWithinDays,
    // platform filter (also used standalone)
    platform,
  } = body;

  const baseQuery = {
    fcmToken: { $ne: null },
    notificationsEnabled: true,
  };

  switch (target) {

    case 'user': {
      if (!userId) throw new Error('userId is required for target "user"');
      const u = await User.findById(userId).select('_id fcmToken notificationsEnabled');
      if (!u?.fcmToken) throw new Error('User has no FCM token registered');
      if (!u.notificationsEnabled) throw new Error('User has notifications disabled');
      return [u];
    }

    case 'users': {
      if (!Array.isArray(userIds) || userIds.length === 0)
        throw new Error('userIds array is required for target "users"');
      return User.find({ _id: { $in: userIds }, ...baseQuery }).select('_id fcmToken');
    }

    case 'ios':
      return User.find({ ...baseQuery, platform: 'ios' }).select('_id fcmToken');

    case 'android':
      return User.find({ ...baseQuery, platform: 'android' }).select('_id fcmToken');

    case 'streak': {
      if (streakMin === undefined) throw new Error('streakMin is required for target "streak"');
      const streakQuery = { streakDays: { $gte: Number(streakMin) } };
      if (streakMax !== undefined) streakQuery.streakDays.$lte = Number(streakMax);
      const gamDocs = await Gamification.find(streakQuery).select('user');
      const userIdList = gamDocs.map(g => g.user);
      return User.find({ _id: { $in: userIdList }, ...baseQuery }).select('_id fcmToken');
    }

    case 'coins': {
      if (coinsMin === undefined) throw new Error('coinsMin is required for target "coins"');
      const gamDocs = await Gamification.find({
        coinsBalance: { $gte: Number(coinsMin) },
      }).select('user');
      const userIdList = gamDocs.map(g => g.user);
      return User.find({ _id: { $in: userIdList }, ...baseQuery }).select('_id fcmToken');
    }

    case 'gender': {
      if (!gender) throw new Error('gender is required for target "gender" (M / F / O)');
      return User.find({ ...baseQuery, gender }).select('_id fcmToken');
    }

    case 'provider': {
      if (!provider) throw new Error('provider is required for target "provider" (email / google / apple)');
      return User.find({ ...baseQuery, provider }).select('_id fcmToken');
    }

    case 'profileComplete': {
      const isComplete = profileComplete !== false; // default true
      return User.find({ ...baseQuery, isProfileCompleted: isComplete }).select('_id fcmToken');
    }

    case 'newUsers': {
      const days = Number(registeredWithinDays ?? 7);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      return User.find({ ...baseQuery, createdAt: { $gte: since } }).select('_id fcmToken');
    }

    case 'all':
    default: {
      // Optional platform sub-filter on broadcast
      const q = { ...baseQuery };
      if (platform === 'ios')     q.platform = 'ios';
      if (platform === 'android') q.platform = 'android';
      return User.find(q).select('_id fcmToken');
    }
  }
}

// ─── Build a single FCM message object ───────────────────────────────────────
function buildMessage(token, { title, body, imageUrl, fcmData, channelId, sound, badge, priority }) {
  return {
    token,
    notification: {
      title,
      body,
      ...(imageUrl && { imageUrl }),
    },
    data: fcmData,
    android: {
      priority,
      notification: {
        channelId,
        sound,
        ...(imageUrl && { imageUrl }),
        defaultVibrateTimings: true,
      },
    },
    apns: {
      payload: {
        aps: {
          sound,
          badge,
          'mutable-content': imageUrl ? 1 : 0,
        },
      },
      ...(imageUrl && { fcmOptions: { imageUrl } }),
    },
  };
}

// ─── POST /notification/send ──────────────────────────────────────────────────
/**
 * Body:
 * {
 *   title:    string          (required)
 *   body:     string          (required)
 *
 *   // ── Targeting ──────────────────────────────────────────────────────────
 *   target:   'all' | 'ios' | 'android' | 'user' | 'users' |
 *             'streak' | 'coins' | 'gender' | 'provider' |
 *             'profileComplete' | 'newUsers'
 *             (default: 'all')
 *
 *   userId:   string          (target: 'user')
 *   userIds:  string[]        (target: 'users')
 *   platform: 'ios'|'android' (target: 'all' — optional sub-filter)
 *   streakMin: number         (target: 'streak')
 *   streakMax: number         (target: 'streak', optional)
 *   coinsMin:  number         (target: 'coins')
 *   gender:    'M'|'F'|'O'   (target: 'gender')
 *   provider:  'email'|'google'|'apple' (target: 'provider')
 *   profileComplete: boolean  (target: 'profileComplete', default true)
 *   registeredWithinDays: number (target: 'newUsers', default 7)
 *
 *   // ── Content ────────────────────────────────────────────────────────────
 *   imageUrl: string
 *   type:     'GOAL'|'HYDRATION'|'PRODUCT'|'CHALLENGE'|'COIN'|'SECURITY'|'HEART'
 *   screen:   string          (deep-link screen name)
 *   params:   object          (deep-link params)
 *   data:     object          (extra arbitrary data)
 *
 *   // ── Android / iOS options ──────────────────────────────────────────────
 *   channelId: string         (default: 'athlofit_push')
 *   sound:     string         (default: 'default')
 *   badge:     number         (default: 1)
 *   priority:  'high'|'normal'(default: 'high')
 * }
 */
const sendNotification = async (req, res, next) => {
  try {
    const {
      title,
      body,
      imageUrl,
      type      = 'GOAL',
      screen,
      params    = {},
      channelId = 'athlofit_push',
      sound     = 'default',
      badge     = 1,
      priority  = 'high',
      data      = {},
    } = req.body;

    if (!title || !body) {
      return error(res, 'title and body are required', 400);
    }

    if (screen && !VALID_SCREENS.includes(screen)) {
      return error(
        res,
        `Invalid screen "${screen}". Call GET /notification/screens for valid values.`,
        400,
      );
    }

    // ── Resolve targets ───────────────────────────────────────────────────
    let targetUserDocs;
    try {
      targetUserDocs = await resolveTargets(req.body);
    } catch (e) {
      return error(res, e.message, 400);
    }

    if (!targetUserDocs || targetUserDocs.length === 0) {
      return error(res, 'No eligible devices found for the given target', 400);
    }

    const tokens = targetUserDocs.map(u => u.fcmToken).filter(Boolean);

    // ── Build FCM data payload (all values must be strings) ───────────────
    const fcmData = {
      ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      type: String(type),
      ...(screen && { screen: String(screen) }),
      ...(Object.keys(params).length > 0 && { params: JSON.stringify(params) }),
    };

    const msgOpts = { title, body, imageUrl, fcmData, channelId, sound, badge, priority };

    // ── Send in batches of 500 ────────────────────────────────────────────
    const BATCH = 500;
    const results = { successCount: 0, failureCount: 0 };
    const staleTokens = [];

    for (let i = 0; i < tokens.length; i += BATCH) {
      const batch = tokens.slice(i, i + BATCH);
      const messages = batch.map(token => buildMessage(token, msgOpts));

      const response = await admin.messaging().sendEach(messages);
      results.successCount += response.successCount;
      results.failureCount += response.failureCount;

      response.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
          ) {
            staleTokens.push(batch[idx]);
          }
        }
      });
    }

    // ── Clean stale tokens ────────────────────────────────────────────────
    if (staleTokens.length > 0) {
      await User.updateMany(
        { fcmToken: { $in: staleTokens } },
        { $set: { fcmToken: null } },
      );
    }

    // ── Persist to DB for each target user ────────────────────────────────
    const notifDocs = targetUserDocs.map(u => ({
      user:    u._id,
      type,
      title,
      message: body,
      data:    { ...fcmData, ...(imageUrl && { imageUrl }) },
    }));
    Notification.insertMany(notifDocs).catch(() => {});

    return success(res, 'Notification sent', {
      successCount: results.successCount,
      failureCount: results.failureCount,
      totalTargets: tokens.length,
      staleRemoved: staleTokens.length,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /notification/screens ────────────────────────────────────────────────
const getScreens = (_req, res) =>
  res.json({ success: true, data: VALID_SCREENS });

// ─── GET /notification/targets ────────────────────────────────────────────────
const getTargets = (_req, res) =>
  res.json({
    success: true,
    data: {
      targets: VALID_TARGETS,
      descriptions: {
        all:             'All users with a valid FCM token',
        ios:             'iOS devices only',
        android:         'Android devices only',
        user:            'Single user — requires userId',
        users:           'Specific users — requires userIds[]',
        streak:          'Users with streak >= streakMin (optional streakMax)',
        coins:           'Users with coins >= coinsMin',
        gender:          'Users by gender — M | F | O',
        provider:        'Users by auth provider — email | google | apple',
        profileComplete: 'Users who have (or have not) completed their profile',
        newUsers:        'Users registered within last N days (registeredWithinDays, default 7)',
      },
    },
  });

module.exports = { sendNotification, getScreens, getTargets };
