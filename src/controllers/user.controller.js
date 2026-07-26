// src/controllers/user.controller.js
const User = require("../models/User.model");
const Order = require("../models/Order.model");
const Gamification = require("../models/Gamification.model");
const HealthActivity = require("../models/HealthActivity.model");
const Notification = require("../models/Notification.model");
const { success, error } = require("../utils/response");
const { todayISO, daysBetween } = require("../utils/date");
const { uploadImage } = require("../utils/uploadImage");
const { createNotification } = require("../utils/createNotification");

// ─── GET /user/profile ────────────────────────────────────────────────────────
const getProfile = async (req, res, next) => {
  try {
    return success(res, "Profile fetched", req.user);
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /user/profile ──────────────────────────────────────────────────────
const updateProfile = async (req, res, next) => {
  try {
    const allowed = [
      "name",
      "phone",
      "dob",
      "gender",
      "height",
      "weight",
      "bloodType",
      "dailyStepGoal",
      "unitSystem",
      "heightUnit",
      "weightUnit",
    ];

    const updates = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    });

    // If phone number is being changed, reset phoneVerified
    if (updates.phone && updates.phone !== req.user.phone) {
      // Strip +91 prefix for consistent comparison
      const newPhone = updates.phone.replace(/^\+?91/, '').replace(/\D/g, '');
      const currentPhone = (req.user.phone || '').replace(/^\+?91/, '').replace(/\D/g, '');
      if (newPhone !== currentPhone) {
        updates.phoneVerified = false;
        updates.phone = newPhone; // store clean 10-digit number
      }
    }

    // Compute age from dob if provided (BUG-014: month/day-aware)
    if (updates.dob) {
      const dob = new Date(updates.dob);
      const today = new Date();
      let age = today.getFullYear() - dob.getFullYear();
      const m = today.getMonth() - dob.getMonth();
      if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
      updates.age = age;
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true },
    );

    return success(res, "Profile updated", user);
  } catch (err) {
    next(err);
  }
};

// ─── POST /user/complete-profile ──────────────────────────────────────────────
const completeProfile = async (req, res, next) => {
  try {
    const { phone, dob, gender, height, weight, bloodType, avatarUrl, heightUnit, weightUnit } =
      req.body;

    // BUG-014: month/day-aware age calculation
    const dobDate = new Date(dob);
    const today = new Date();
    let age = today.getFullYear() - dobDate.getFullYear();
    const m = today.getMonth() - dobDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dobDate.getDate())) age--;

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
          heightUnit: heightUnit || "cm",
          weightUnit: weightUnit || "kg",
          isProfileCompleted: true,
        },
      },
      { new: true, runValidators: true },
    );

    return success(res, "Profile completed", {
      status: "success",
      message: "Profile completed",
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

    if (!dailyStepGoal || dailyStepGoal < 3000) {
      return error(res, "Step goal must be at least 3,000", 400);
    }

    // FIX #11: Upper bound validation — no one walks 100k+ steps in a day
    if (dailyStepGoal > 100000) {
      return error(res, "Step goal cannot exceed 100,000", 400);
    }

    // ── 90-day cooldown check ─────────────────────────────────────────────────
    // After changing the step goal, users must wait 90 days before changing again.
    const todayStr = todayISO();
    const lastChangeDate = req.user.lastStepGoalChangeDate;
    if (lastChangeDate) {
      const daysSinceLastChange = daysBetween(lastChangeDate, todayStr);
      if (daysSinceLastChange !== null && daysSinceLastChange < 90) {
        const daysRemaining = 90 - daysSinceLastChange;
        return error(
          res,
          `You can change your step goal again after ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`,
          429,
        );
      }
    }

    // Calculate tomorrow's date using IST-aware todayISO() for consistency
    // with the sync endpoint that applies pending goals.
    const [y, m, d] = todayStr.split('-').map(Number);
    const tomorrow = new Date(y, m - 1, d + 1);
    const effectiveDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        $set: {
          pendingStepGoal: dailyStepGoal,
          pendingGoalEffectiveDate: effectiveDate,
          lastStepGoalChangeDate: todayStr,
        },
      },
      { new: true },
    );

    return success(res, "Step goal updated — takes effect tomorrow", {
      dailyStepGoal: user.dailyStepGoal,
      pendingStepGoal: user.pendingStepGoal,
      pendingGoalEffectiveDate: user.pendingGoalEffectiveDate,
      lastStepGoalChangeDate: user.lastStepGoalChangeDate,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /user/notifications ──────────────────────────────────────────────────
const getNotifications = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const limit = Math.min(100, parseInt(req.query.limit || "50", 10));
    const skip = parseInt(req.query.skip || "0", 10);

    const notifications = await Notification.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const unreadCount = await Notification.countDocuments({
      user: userId,
      read: false,
    });

    return success(res, "Notifications fetched", {
      notifications: notifications.map((n) => n.toJSON()),
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
    if (!notif) return error(res, "Notification not found", 404);
    return success(res, "Marked as read", notif.toJSON());
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /user/notifications/read-all ──────────────────────────────────────
const markAllNotificationsRead = async (req, res, next) => {
  try {
    await Notification.updateMany(
      { user: req.user._id, read: false },
      { $set: { read: true } },
    );
    return success(res, "All notifications marked as read");
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /user/notifications/:id ──────────────────────────────────────────
const deleteNotification = async (req, res, next) => {
  try {
    const notif = await Notification.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!notif) return error(res, "Notification not found", 404);
    return success(res, "Notification deleted");
  } catch (err) {
    next(err);
  }
};

// ─── POST /user/upload-avatar ─────────────────────────────────────────────────
// Accepts multipart/form-data with field "avatar" (single image).
// Uploads to Cloudinary, saves URL to user, returns updated user.
const uploadAvatar = async (req, res, next) => {
  try {
    if (!req.file) return error(res, "No image file provided", 400);

    const avatarUrl = await uploadImage(req.file, "avatars", {
      faceCrop: true,
      publicId: `user_${req.user._id}`, // Cloudinary fallback: deterministic id
    });

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { avatarUrl } },
      { new: true },
    );

    return success(res, "Avatar uploaded", { avatarUrl, user });
  } catch (err) {
    next(err);
  }
};

// ─── GET /user/addresses ───────────────────────────────────────────────────────
const getAddresses = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select("savedAddresses");
    return success(res, "Addresses fetched", user.savedAddresses || []);
  } catch (err) {
    next(err);
  }
};

// ─── POST /user/addresses ──────────────────────────────────────────────────────
const addAddress = async (req, res, next) => {
  try {
    const {
      label,
      fullName,
      phone,
      street,
      city,
      state,
      zipCode,
      country,
      isDefault,
    } = req.body;

    if (!street || !city || !state || !zipCode) {
      return error(res, "Street, city, state and zipCode are required", 400);
    }

    const user = await User.findById(req.user._id);

    // If new address is default, clear existing default
    if (isDefault) {
      user.savedAddresses.forEach((a) => {
        a.isDefault = false;
      });
    }

    // If this is the first address, force it as default
    const forceDefault =
      user.savedAddresses.length === 0 ? true : isDefault || false;

    user.savedAddresses.push({
      label: label || "Home",
      fullName: fullName || req.user.name || "",
      phone: phone || req.user.phone || "",
      street,
      city,
      state,
      zipCode,
      country: country || "India",
      isDefault: forceDefault,
    });

    await user.save();
    return success(res, "Address added", user.savedAddresses);
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /user/addresses/:addressId ─────────────────────────────────────────
const updateAddress = async (req, res, next) => {
  try {
    const { addressId } = req.params;
    const {
      label,
      fullName,
      phone,
      street,
      city,
      state,
      zipCode,
      country,
      isDefault,
    } = req.body;

    const user = await User.findById(req.user._id);
    const addr = user.savedAddresses.id(addressId);

    if (!addr) return error(res, "Address not found", 404);

    if (label !== undefined) addr.label = label;
    if (fullName !== undefined) addr.fullName = fullName;
    if (phone !== undefined) addr.phone = phone;
    if (street !== undefined) addr.street = street;
    if (city !== undefined) addr.city = city;
    if (state !== undefined) addr.state = state;
    if (zipCode !== undefined) addr.zipCode = zipCode;
    if (country !== undefined) addr.country = country;

    if (isDefault) {
      user.savedAddresses.forEach((a) => {
        a.isDefault = false;
      });
      addr.isDefault = true;
    }

    await user.save();
    return success(res, "Address updated", user.savedAddresses);
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /user/addresses/:addressId ────────────────────────────────────────
const deleteAddress = async (req, res, next) => {
  try {
    const { addressId } = req.params;
    const user = await User.findById(req.user._id);

    const idx = user.savedAddresses.findIndex(
      (a) => a._id.toString() === addressId,
    );
    if (idx === -1) return error(res, "Address not found", 404);

    const wasDefault = user.savedAddresses[idx].isDefault;
    user.savedAddresses.splice(idx, 1);

    // If deleted address was default, assign default to first remaining
    if (wasDefault && user.savedAddresses.length > 0) {
      user.savedAddresses[0].isDefault = true;
    }

    await user.save();
    return success(res, "Address deleted", user.savedAddresses);
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
    if (!title || !message)
      return error(res, "title and message are required", 400);

    const notif = await Notification.create({
      user: req.user._id,
      type: type || "GOAL",
      title,
      message,
      data: data || {},
    });

    return success(res, "Notification saved", notif.toJSON(), 201);
  } catch (err) {
    next(err);
  }
};
const updateFcmToken = async (req, res, next) => {
  try {
    const { fcmToken, notificationsEnabled, platform } = req.body;

    const updates = {};
    if (fcmToken !== undefined) updates.fcmToken = fcmToken || null;
    if (notificationsEnabled !== undefined)
      updates.notificationsEnabled = notificationsEnabled;
    if (platform !== undefined) updates.platform = platform || null;

    await User.findByIdAndUpdate(req.user._id, { $set: updates });
    return success(res, "FCM token updated");
  } catch (err) {
    next(err);
  }
};

// ─── POST /user/request-deletion ──────────────────────────────────────────────
// User requests account deletion. Sets status to 'pending' and schedules deletion
// for 30 days from now (grace period for cancellation).
const requestAccountDeletion = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const user = await User.findById(req.user._id);

    // Check if there's already an active deletion request
    if (
      user.deletionRequest &&
      (user.deletionRequest.status === "pending" ||
        user.deletionRequest.status === "in_progress")
    ) {
      return error(res, "Account deletion request already exists", 400);
    }

    // Set deletion request with 30-day grace period
    const scheduledDate = new Date();
    scheduledDate.setDate(scheduledDate.getDate() + 30);

    user.deletionRequest = {
      status: "pending",
      requestedAt: new Date(),
      scheduledDeletionDate: scheduledDate,
      reason: reason || null,
      cancelledAt: null,
      completedAt: null,
    };

    await user.save();

    // Send notification about deletion request
    // await createNotification(user._id, {
    //   type: 'SYSTEM',
    //   title: '⚠️ Account Deletion Requested',
    //   message: `Your account is scheduled for deletion on ${scheduledDate.toLocaleDateString()}. You can cancel this request anytime before that date.`,
    //   data: { screen: 'SettingsScreen' },
    // });

    return success(res, "Account deletion requested", {
      status: user.deletionRequest.status,
      scheduledDeletionDate: user.deletionRequest.scheduledDeletionDate,
      requestedAt: user.deletionRequest.requestedAt,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /user/cancel-deletion ───────────────────────────────────────────────
// User cancels their account deletion request
const cancelAccountDeletion = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);

    if (
      !user.deletionRequest ||
      (user.deletionRequest.status !== "pending" &&
        user.deletionRequest.status !== "in_progress")
    ) {
      return error(res, "No active deletion request found", 400);
    }

    user.deletionRequest = {
      status: "cancelled",
      requestedAt: user.deletionRequest.requestedAt,
      scheduledDeletionDate: null,
      reason: user.deletionRequest.reason,
      cancelledAt: new Date(),
      completedAt: null,
    };

    await user.save();

    // Send notification about cancellation
    await createNotification(user._id, {
      type: "SYSTEM",
      title: "✅ Deletion Request Cancelled",
      message:
        "Your account deletion request has been cancelled. Your account is safe.",
      data: { screen: "SettingsScreen" },
    });

    return success(res, "Account deletion cancelled", {
      status: user.deletionRequest.status,
      cancelledAt: user.deletionRequest.cancelledAt,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /user/deletion-status ────────────────────────────────────────────────
// Get current account deletion status
const getDeletionStatus = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select("deletionRequest");

    // If deletionRequest doesn't exist, return default 'none' status
    if (!user.deletionRequest) {
      return success(res, "Deletion status fetched", {
        status: "none",
        requestedAt: null,
        scheduledDeletionDate: null,
        reason: null,
        cancelledAt: null,
        completedAt: null,
      });
    }

    return success(res, "Deletion status fetched", {
      status: user.deletionRequest.status || "none",
      requestedAt: user.deletionRequest.requestedAt || null,
      scheduledDeletionDate: user.deletionRequest.scheduledDeletionDate || null,
      reason: user.deletionRequest.reason || null,
      cancelledAt: user.deletionRequest.cancelledAt || null,
      completedAt: user.deletionRequest.completedAt || null,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /user/bonus-steps ────────────────────────────────────────────────────
// Returns the user's bonus step history (admin/system credited steps).
const getBonusStepsHistory = async (req, res, next) => {
  try {
    const BonusSteps = require("../models/BonusSteps.model");

    const limit = Math.min(50, parseInt(req.query.limit || "20", 10));
    const skip = parseInt(req.query.skip || "0", 10);

    const [entries, total] = await Promise.all([
      BonusSteps.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("steps date reason source createdAt"),
      BonusSteps.countDocuments({ user: req.user._id }),
    ]);

    // Also get today's total bonus steps for quick reference
    const today = todayISO();
    const todayBonus = await BonusSteps.aggregate([
      { $match: { user: req.user._id, date: today } },
      { $group: { _id: null, total: { $sum: "$steps" } } },
    ]);

    return success(res, "Bonus steps history fetched", {
      entries: entries.map(e => ({
        _id: e._id,
        steps: e.steps,
        date: e.date,
        reason: e.reason,
        source: e.source,
        createdAt: e.createdAt,
      })),
      total,
      todayBonusSteps: todayBonus[0]?.total || 0,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getProfile,
  updateProfile,
  completeProfile,
  updateStepGoal,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  saveIncomingNotification,
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  uploadAvatar,
  updateFcmToken,
  requestAccountDeletion,
  cancelAccountDeletion,
  getDeletionStatus,
  getBonusStepsHistory,
};
