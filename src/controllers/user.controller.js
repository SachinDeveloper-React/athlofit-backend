// src/controllers/user.controller.js
const User = require('../models/User.model');
const Order = require('../models/Order.model');
const Gamification = require('../models/Gamification.model');
const HealthActivity = require('../models/HealthActivity.model');
const { success, error } = require('../utils/response');
const { todayISO } = require('../utils/date');

// ─── GET /user/profile ────────────────────────────────────────────────────────
const getProfile = async (req, res, next) => {
  try {
    return success(res, 'Profile fetched', req.user);
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /user/profile ──────────────────────────────────────────────────────
const updateProfile = async (req, res, next) => {
  try {
    const allowed = [
      'name', 'phone', 'dob', 'gender', 'height',
      'weight', 'bloodType', 'avatarUrl', 'dailyStepGoal', 'unitSystem',
    ];

    const updates = {};
    allowed.forEach(key => {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    });

    // Compute age from dob if provided
    if (updates.dob) {
      const birthYear = new Date(updates.dob).getFullYear();
      updates.age = new Date().getFullYear() - birthYear;
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    return success(res, 'Profile updated', user);
  } catch (err) {
    next(err);
  }
};

// ─── POST /user/complete-profile ──────────────────────────────────────────────
const completeProfile = async (req, res, next) => {
  try {
    const { phone, dob, gender, height, weight, bloodType, avatarUrl } = req.body;

    const birthYear = new Date(dob).getFullYear();
    const age = new Date().getFullYear() - birthYear;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        $set: {
          phone,
          dob,
          gender,
          height,
          weight,
          bloodType,
          avatarUrl: avatarUrl ?? null,
          age,
          isProfileCompleted: true,
        },
      },
      { new: true, runValidators: true }
    );

    return success(res, 'Profile completed', {
      status: 'success',
      message: 'Profile completed',
      user,
    });
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /user/step-goal ────────────────────────────────────────────────────
const updateStepGoal = async (req, res, next) => {
  try {
    const { dailyStepGoal } = req.body;

    if (!dailyStepGoal || dailyStepGoal < 100) {
      return error(res, 'Step goal must be at least 100', 400);
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { dailyStepGoal } },
      { new: true }
    );

    return success(res, 'Step goal updated', user);
  } catch (err) {
    next(err);
  }
};

// ─── GET /user/notifications ──────────────────────────────────────────────────
// Synthesizes real in-app notifications from Orders, Gamification, and HealthActivity.
const getNotifications = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const today = todayISO();
    const notifications = [];

    // ── 1. Recent orders (NEW / SHIPPED / DELIVERED) ────────────────────────
    const recentOrders = await Order.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(5);

    for (const order of recentOrders) {
      const shortId = order._id.toString().slice(-6).toUpperCase();
      let title = '', message = '';
      if (order.status === 'PAID') {
        title = 'ORDER CONFIRMED';
        message = `YOUR ORDER #${shortId} HAS BEEN CONFIRMED. WE'RE PREPARING YOUR ITEMS.`;
      } else if (order.status === 'SHIPPED') {
        title = 'ORDER SHIPPED';
        message = `YOUR ORDER #${shortId} IS ON THE WAY! EXPECT DELIVERY SOON.`;
      } else if (order.status === 'DELIVERED') {
        title = 'ORDER DELIVERED';
        message = `YOUR ORDER #${shortId} HAS BEEN DELIVERED. ENJOY YOUR PURCHASE!`;
      } else if (order.status === 'PENDING') {
        title = 'ORDER PLACED';
        message = `YOUR ORDER #${shortId} IS BEING PROCESSED. PAYMENT PENDING.`;
      }

      if (title) {
        notifications.push({
          id: `order_${order._id}`,
          type: 'PRODUCT',
          title,
          message,
          createdAt: new Date(order.createdAt).getTime(),
          read: false,
        });
      }
    }

    // ── 2. Gamification badge unlocks ────────────────────────────────────────
    const gam = await Gamification.findOne({ user: userId });
    if (gam) {
      const badgeEvents = [
        { key: 'starter',    title: 'GOAL ACHIEVED!',          msg: 'CONGRATS! YOU HIT YOUR FIRST STEP STREAK BADGE — STARTER. KEEP IT GOING!',           icon: 'GOAL' },
        { key: 'consistent', title: '7-DAY STREAK UNLOCKED!',  msg: 'YOU\'VE MAINTAINED A 7-DAY STREAK! THE "CONSISTENT" BADGE IS NOW YOURS.',              icon: 'GOAL' },
        { key: 'finisher',   title: '15-DAY STREAK UNLOCKED!', msg: 'INCREDIBLE! 15 CONSECUTIVE DAYS OF ACTIVITY. THE "FINISHER" BADGE HAS BEEN AWARDED.', icon: 'GOAL' },
        { key: 'elite',      title: '30-DAY ELITE BADGE!',     msg: 'YOU\'RE ELITE! A 30-DAY STREAK EARNED YOU THE TOP BADGE. AMAZING DEDICATION!',         icon: 'GOAL' },
      ];

      for (const b of badgeEvents) {
        if (gam.badges?.[b.key]?.unlocked && gam.badges[b.key].unlockedAt) {
          notifications.push({
            id: `badge_${b.key}`,
            type: b.icon,
            title: b.title,
            message: b.msg,
            createdAt: new Date(gam.badges[b.key].unlockedAt).getTime(),
            read: false,
          });
        }
      }

      // Streak warning: if streak is active but no activity today, remind the user
      if (gam.streakDays > 0 && gam.lastActiveDate && gam.lastActiveDate !== today) {
        notifications.push({
          id: 'streak_reminder',
          type: 'GOAL',
          title: 'KEEP YOUR STREAK ALIVE!',
          message: `YOU HAVE A ${gam.streakDays}-DAY STREAK! LOG ACTIVITY TODAY TO KEEP IT GOING.`,
          createdAt: Date.now() - 2 * 60 * 60 * 1000,
          read: false,
        });
      }
    }

    // ── 3. Today's health activity ────────────────────────────────────────────
    const todayActivity = await HealthActivity.findOne({ user: userId, date: today });
    const dailyGoal = req.user.dailyStepGoal || 10000;

    if (todayActivity) {
      // Step goal achieved
      if (todayActivity.goalMet) {
        notifications.push({
          id: 'steps_goal_today',
          type: 'GOAL',
          title: 'GOAL ACHIEVED!',
          message: `YOU SMASHED YOUR DAILY STEP GOAL OF ${dailyGoal.toLocaleString()} STEPS! KEEP IT UP.`,
          createdAt: Date.now() - 1 * 60 * 60 * 1000,
          read: false,
        });
      }

      // Hydration reminder if below 1000ml by midday
      const currentHour = new Date().getHours();
      if (currentHour >= 12 && (todayActivity.hydration || 0) < 1000) {
        notifications.push({
          id: 'hydration_reminder',
          type: 'HYDRATION',
          title: 'HYDRATION REMINDER',
          message: `YOU'VE ONLY HAD ${todayActivity.hydration || 0}ML TODAY. TIME TO DRINK MORE WATER!`,
          createdAt: Date.now() - 30 * 60 * 1000,
          read: false,
        });
      }

      // Elevated heart rate warning
      if ((todayActivity.heartRateMax || 0) > 120) {
        notifications.push({
          id: 'heart_rate_high',
          type: 'HEART',
          title: 'ELEVATED HEART RATE DETECTED',
          message: `YOUR HEART RATE PEAKED AT ${todayActivity.heartRateMax} BPM TODAY. STAY HYDRATED AND REST IF NEEDED.`,
          createdAt: Date.now() - 3 * 60 * 60 * 1000,
          read: false,
        });
      }
    } else {
      // No activity today — generic nudge
      notifications.push({
        id: 'activity_nudge',
        type: 'GOAL',
        title: 'START MOVING!',
        message: `NO STEPS LOGGED YET TODAY. OPEN THE TRACKER TO RECORD YOUR DAILY ACTIVITY AND EARN COINS.`,
        createdAt: Date.now() - 4 * 60 * 60 * 1000,
        read: false,
      });
    }

    // ── Sort by newest first ──────────────────────────────────────────────────
    notifications.sort((a, b) => b.createdAt - a.createdAt);

    return success(res, 'Notifications fetched', notifications);
  } catch (err) {
    next(err);
  }
};

module.exports = { getProfile, updateProfile, completeProfile, updateStepGoal, getNotifications };

// ─── GET /user/addresses ───────────────────────────────────────────────────────
const getAddresses = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('savedAddresses');
    return success(res, 'Addresses fetched', user.savedAddresses || []);
  } catch (err) {
    next(err);
  }
};

// ─── POST /user/addresses ──────────────────────────────────────────────────────
const addAddress = async (req, res, next) => {
  try {
    const { label, fullName, phone, street, city, state, zipCode, country, isDefault } = req.body;

    if (!street || !city || !state || !zipCode) {
      return error(res, 'Street, city, state and zipCode are required', 400);
    }

    const user = await User.findById(req.user._id);

    // If new address is default, clear existing default
    if (isDefault) {
      user.savedAddresses.forEach(a => { a.isDefault = false; });
    }

    // If this is the first address, force it as default
    const forceDefault = user.savedAddresses.length === 0 ? true : (isDefault || false);

    user.savedAddresses.push({
      label: label || 'Home',
      fullName: fullName || req.user.name || '',
      phone: phone || req.user.phone || '',
      street,
      city,
      state,
      zipCode,
      country: country || 'India',
      isDefault: forceDefault,
    });

    await user.save();
    return success(res, 'Address added', user.savedAddresses);
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /user/addresses/:addressId ─────────────────────────────────────────
const updateAddress = async (req, res, next) => {
  try {
    const { addressId } = req.params;
    const { label, fullName, phone, street, city, state, zipCode, country, isDefault } = req.body;

    const user = await User.findById(req.user._id);
    const addr = user.savedAddresses.id(addressId);

    if (!addr) return error(res, 'Address not found', 404);

    if (label    !== undefined) addr.label    = label;
    if (fullName !== undefined) addr.fullName = fullName;
    if (phone    !== undefined) addr.phone    = phone;
    if (street   !== undefined) addr.street   = street;
    if (city     !== undefined) addr.city     = city;
    if (state    !== undefined) addr.state    = state;
    if (zipCode  !== undefined) addr.zipCode  = zipCode;
    if (country  !== undefined) addr.country  = country;

    if (isDefault) {
      user.savedAddresses.forEach(a => { a.isDefault = false; });
      addr.isDefault = true;
    }

    await user.save();
    return success(res, 'Address updated', user.savedAddresses);
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /user/addresses/:addressId ────────────────────────────────────────
const deleteAddress = async (req, res, next) => {
  try {
    const { addressId } = req.params;
    const user = await User.findById(req.user._id);

    const idx = user.savedAddresses.findIndex(a => a._id.toString() === addressId);
    if (idx === -1) return error(res, 'Address not found', 404);

    const wasDefault = user.savedAddresses[idx].isDefault;
    user.savedAddresses.splice(idx, 1);

    // If deleted address was default, assign default to first remaining
    if (wasDefault && user.savedAddresses.length > 0) {
      user.savedAddresses[0].isDefault = true;
    }

    await user.save();
    return success(res, 'Address deleted', user.savedAddresses);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getProfile, updateProfile, completeProfile, updateStepGoal, getNotifications,
  getAddresses, addAddress, updateAddress, deleteAddress,
};


