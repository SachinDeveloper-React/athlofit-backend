// src/controllers/admin.controller.js
// ─── Admin management endpoints (users, dashboard) ───────────────────────────

const User = require('../models/User.model');
const Order = require('../models/Order.model');
const Product = require('../models/Product.model');
const Gamification = require('../models/Gamification.model');
const HealthActivity = require('../models/HealthActivity.model');
const Achievement = require('../models/Achievement.model');
const AppConfig = require('../models/AppConfig.model');
const { success, error } = require('../utils/response');

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── GET /admin/users ─────────────────────────────────────────────────────────
// Query: ?page=1&limit=20&search=&role=
const getUsers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, role } = req.query;
    const filter = {};
    if (role) filter.role = role;
    if (search) {
      const safe = escapeRegex(search);
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { email: { $regex: safe, $options: 'i' } },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, parseInt(limit, 10));
    const skip = (pageNum - 1) * limitNum;

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('-password -otp -otpExpires')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      User.countDocuments(filter),
    ]);

    return success(res, 'Users fetched', {
      users,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id ───────────────────────────────────────────────────
const getUserById = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select('-password -otp -otpExpires');
    if (!user) return error(res, 'User not found', 404);
    return success(res, 'User fetched', user);
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /admin/users/:id/role ─────────────────────────────────────────────
const updateUserRole = async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!['user', 'admin'].includes(role)) {
      return error(res, 'Role must be "user" or "admin"', 400);
    }
    // Prevent an admin from demoting themselves (avoids lockout)
    if (req.params.id === req.user._id.toString() && role !== 'admin') {
      return error(res, 'You cannot change your own admin role', 400);
    }
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { role } },
      { new: true },
    ).select('-password -otp -otpExpires');
    if (!user) return error(res, 'User not found', 404);
    return success(res, 'User role updated', user);
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /admin/users/:id ──────────────────────────────────────────────────
const deleteUser = async (req, res, next) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return error(res, 'You cannot delete your own account', 400);
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return error(res, 'User not found', 404);
    // Clean up the user's gamification record (best-effort)
    await Gamification.deleteOne({ user: user._id }).catch(() => {});
    return success(res, 'User deleted', { id: req.params.id });
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/health ─────────────────────────────────────────────
// Returns recent daily activity + summary totals + coin-per-step rate.
const getUserHealth = async (req, res, next) => {
  try {
    const activities = await HealthActivity.find({ user: req.params.id })
      .sort({ date: -1 })
      .limit(60);

    // Pull the coin-per-step rate from app config (per 100 steps).
    const cfg = await AppConfig.findOne({ key: 'global' });
    const ratePer100 = cfg?.coin_config?.steps?.rate_per_100_steps ?? 0.5;

    // Aggregate lifetime totals
    const agg = await HealthActivity.aggregate([
      { $match: { user: new (require('mongoose').Types.ObjectId)(req.params.id) } },
      {
        $group: {
          _id: null,
          totalSteps: { $sum: '$steps' },
          totalDistance: { $sum: '$distance' },
          totalCalories: { $sum: '$calories' },
          totalHydration: { $sum: '$hydration' },
          daysTracked: { $sum: 1 },
          goalsMet: { $sum: { $cond: ['$goalMet', 1, 0] } },
        },
      },
    ]);

    const totals = agg[0] || {
      totalSteps: 0, totalDistance: 0, totalCalories: 0,
      totalHydration: 0, daysTracked: 0, goalsMet: 0,
    };

    // Decorate each day with the coins those steps are worth.
    const days = activities.map((a) => {
      const obj = a.toJSON();
      obj.stepCoins = Math.round((a.steps / 100) * ratePer100 * 100) / 100;
      return obj;
    });

    return success(res, 'User health fetched', {
      days,
      summary: {
        ...totals,
        totalStepCoins: Math.round((totals.totalSteps / 100) * ratePer100 * 100) / 100,
        ratePer100Steps: ratePer100,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/achievements ───────────────────────────────────────
// Returns all achievements with the user's claim status + progress.
const getUserAchievements = async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const userId = req.params.id;

    const [achievements, gam, healthAgg, ordersCount] = await Promise.all([
      Achievement.find({}).sort({ targetValue: 1 }),
      Gamification.findOne({ user: userId }),
      HealthActivity.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(userId) } },
        {
          $group: {
            _id: null,
            totalSteps: { $sum: '$steps' },
            totalWater: { $sum: '$hydration' },
            maxDailySteps: { $max: '$steps' },
          },
        },
      ]),
      Order.countDocuments({ user: userId, status: { $ne: 'CANCELLED' } }),
    ]);

    const stats = healthAgg[0] || { totalSteps: 0, totalWater: 0, maxDailySteps: 0 };
    const claimedIds = new Set(
      (gam?.claimedAchievements || []).map((c) => c.achievementId?.toString()),
    );

    const currentFor = (type) => {
      switch (type) {
        case 'STEPS_TOTAL': return stats.totalSteps;
        case 'STEPS_DAILY': return stats.maxDailySteps;
        case 'WATER_TOTAL': return stats.totalWater;
        case 'ORDERS_COUNT': return ordersCount;
        default: return 0;
      }
    };

    const result = achievements.map((a) => {
      const current = currentFor(a.criteriaType);
      const claimed = claimedIds.has(a._id.toString());
      return {
        _id: a._id,
        key: a.key,
        title: a.title,
        description: a.description,
        reward: a.reward,
        icon: a.icon,
        criteriaType: a.criteriaType,
        targetValue: a.targetValue,
        current,
        progress: Math.min(100, Math.round((current / a.targetValue) * 100)),
        achieved: current >= a.targetValue,
        claimed,
      };
    });

    return success(res, 'User achievements fetched', result);
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/gamification ───────────────────────────────────────
const getUserGamification = async (req, res, next) => {
  try {
    const gam = await Gamification.findOne({ user: req.params.id });
    if (!gam) return success(res, 'No gamification record', null);

    // Attach badge definitions so the admin sees titles/emojis, not just keys.
    let badges = [];
    try {
      const BadgeDefinition = require('../models/BadgeDefinition.model');
      const defs = await BadgeDefinition.find({}).sort({ order: 1 });
      badges = gam.getBadgeList(defs);
    } catch {
      badges = gam.badgeList || [];
    }

    const data = gam.toJSON();
    data.badges = badges;
    return success(res, 'User gamification fetched', data);
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/orders ─────────────────────────────────────────────
const getUserOrders = async (req, res, next) => {
  try {
    const orders = await Order.find({ user: req.params.id })
      .populate('items.product', 'name images')
      .sort({ createdAt: -1 });
    return success(res, 'User orders fetched', orders);
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/dashboard/stats ──────────────────────────────────────────────
const getDashboardStats = async (req, res, next) => {
  try {
    const [totalUsers, totalAdmins, totalProducts, totalOrders, revenueAgg] =
      await Promise.all([
        User.countDocuments({}),
        User.countDocuments({ role: 'admin' }),
        Product.countDocuments({ isActive: true }),
        Order.countDocuments({}),
        Order.aggregate([
          { $match: { status: { $in: ['PAID', 'SHIPPED', 'DELIVERED'] } } },
          { $group: { _id: null, total: { $sum: '$totalPrice' } } },
        ]),
      ]);

    const totalRevenue = revenueAgg[0]?.total || 0;

    return success(res, 'Dashboard stats fetched', {
      totalUsers,
      totalAdmins,
      totalProducts,
      totalOrders,
      totalRevenue,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getUsers,
  getUserById,
  updateUserRole,
  deleteUser,
  getUserHealth,
  getUserGamification,
  getUserAchievements,
  getUserOrders,
  getDashboardStats,
};
