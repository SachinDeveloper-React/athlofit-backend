// src/controllers/user.controller.js
const User = require('../models/User.model');
const Order = require('../models/Order.model');
const Gamification = require('../models/Gamification.model');
const HealthActivity = require('../models/HealthActivity.model');
const Notification = require('../models/Notification.model');
const { success, error } = require('../utils/response');
const { todayISO } = require('../utils/date');
const { uploadBuffer } = require('../utils/cloudinary');

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
const getNotifications = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const limit  = Math.min(100, parseInt(req.query.limit || '50', 10));
    const skip   = parseInt(req.query.skip || '0', 10);

    const notifications = await Notification.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const unreadCount = await Notification.countDocuments({ user: userId, read: false });

    return success(res, 'Notifications fetched', {
      notifications: notifications.map(n => n.toJSON()),
      unreadCount,
    });
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /user/notifications/:id/read ──────────────────────────────────────
const markNotificationRead = async (req, res, next) => {
  try {
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { read: true } },
      { new: true },
    );
    if (!notif) return error(res, 'Notification not found', 404);
    return success(res, 'Marked as read', notif.toJSON());
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /user/notifications/read-all ──────────────────────────────────────
const markAllNotificationsRead = async (req, res, next) => {
  try {
    await Notification.updateMany({ user: req.user._id, read: false }, { $set: { read: true } });
    return success(res, 'All notifications marked as read');
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /user/notifications/:id ──────────────────────────────────────────
const deleteNotification = async (req, res, next) => {
  try {
    const notif = await Notification.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!notif) return error(res, 'Notification not found', 404);
    return success(res, 'Notification deleted');
  } catch (err) {
    next(err);
  }
};

// ─── POST /user/upload-avatar ─────────────────────────────────────────────────
// Accepts multipart/form-data with field "avatar" (single image).
// Uploads to Cloudinary, saves URL to user, returns updated user.
const uploadAvatar = async (req, res, next) => {
  try {
    if (!req.file) return error(res, 'No image file provided', 400);

    const avatarUrl = await uploadBuffer(
      req.file.buffer,
      'athlofit/avatars',
      `user_${req.user._id}`,   // deterministic public_id — overwrites previous avatar
    );

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { avatarUrl } },
      { new: true },
    );

    return success(res, 'Avatar uploaded', { avatarUrl, user });
  } catch (err) {
    next(err);
  }
};

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

// ─── POST /user/notifications ─────────────────────────────────────────────────
// Called by the app when an FCM message arrives in foreground/background
// so it gets persisted to the DB (push was already shown by Notifee).
const saveIncomingNotification = async (req, res, next) => {
  try {
    const { type, title, message, data } = req.body;
    if (!title || !message) return error(res, 'title and message are required', 400);

    const Notification = require('../models/Notification.model');
    const notif = await Notification.create({
      user:    req.user._id,
      type:    type || 'GOAL',
      title,
      message,
      data:    data || {},
    });

    return success(res, 'Notification saved', notif.toJSON(), 201);
  } catch (err) {
    next(err);
  }
};
const updateFcmToken = async (req, res, next) => {
  try {
    const { fcmToken, notificationsEnabled, platform } = req.body;

    const updates = {};
    if (fcmToken !== undefined) updates.fcmToken = fcmToken || null;
    if (notificationsEnabled !== undefined) updates.notificationsEnabled = notificationsEnabled;
    if (platform !== undefined) updates.platform = platform || null;

    await User.findByIdAndUpdate(req.user._id, { $set: updates });
    return success(res, 'FCM token updated');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getProfile, updateProfile, completeProfile, updateStepGoal,
  getNotifications, markNotificationRead, markAllNotificationsRead,
  deleteNotification, saveIncomingNotification,
  getAddresses, addAddress, updateAddress, deleteAddress, uploadAvatar,
  updateFcmToken,
};


