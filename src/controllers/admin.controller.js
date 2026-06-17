// src/controllers/admin.controller.js
// ─── Admin management endpoints (users, dashboard) ───────────────────────────

const User = require('../models/User.model');
const Order = require('../models/Order.model');
const Product = require('../models/Product.model');
const Gamification = require('../models/Gamification.model');
const HealthActivity = require('../models/HealthActivity.model');
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
const getUserHealth = async (req, res, next) => {
  try {
    const activities = await HealthActivity.find({ user: req.params.id })
      .sort({ date: -1 })
      .limit(30);
    return success(res, 'User health fetched', activities);
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/gamification ───────────────────────────────────────
const getUserGamification = async (req, res, next) => {
  try {
    const gam = await Gamification.findOne({ user: req.params.id });
    return success(res, 'User gamification fetched', gam);
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
  getUserOrders,
  getDashboardStats,
};
