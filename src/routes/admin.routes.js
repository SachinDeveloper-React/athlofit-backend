// src/routes/admin.routes.js
// ─── Admin-only routes for the admin panel ────────────────────────────────────
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User.model');
const Order = require('../models/Order.model');
const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const Coupon = require('../models/Coupon.model');
const Gamification = require('../models/Gamification.model');
const HealthActivity = require('../models/HealthActivity.model');
const { protect, adminOnly } = require('../middleware/auth.middleware');
const { success, error } = require('../utils/response');

// All admin routes require auth + admin role
router.use(protect, adminOnly);

// ─── GET /admin/users ─────────────────────────────────────────────────────────
router.get('/users', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search = '', role = '' } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, parseInt(limit));
    const skip = (pageNum - 1) * limitNum;

    const filter = {};
    if (role) filter.role = role;
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { email: { $regex: safe, $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).select('-password -otp -otpExpires'),
      User.countDocuments(filter),
    ]);

    return success(res, 'Users fetched', {
      users,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) { next(err); }
});

// ─── GET /admin/users/:id ─────────────────────────────────────────────────────
router.get('/users/:id', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select('-password -otp -otpExpires');
    if (!user) return error(res, 'User not found', 404);
    return success(res, 'User fetched', user);
  } catch (err) { next(err); }
});

// ─── PATCH /admin/users/:id/role ─────────────────────────────────────────────
router.patch('/users/:id/role', async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!['user', 'admin'].includes(role)) return error(res, 'Invalid role', 400);
    const user = await User.findByIdAndUpdate(req.params.id, { $set: { role } }, { new: true }).select('-password');
    if (!user) return error(res, 'User not found', 404);
    return success(res, 'Role updated', user);
  } catch (err) { next(err); }
});

// ─── DELETE /admin/users/:id ──────────────────────────────────────────────────
router.delete('/users/:id', async (req, res, next) => {
  try {
    if (req.params.id === req.user._id.toString()) return error(res, 'Cannot delete your own account', 400);
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return error(res, 'User not found', 404);
    // Clean up related data
    await Promise.allSettled([
      Gamification.deleteOne({ user: req.params.id }),
      HealthActivity.deleteMany({ user: req.params.id }),
    ]);
    return success(res, 'User deleted');
  } catch (err) { next(err); }
});

// ─── GET /admin/users/:id/gamification ───────────────────────────────────────
router.get('/users/:id/gamification', async (req, res, next) => {
  try {
    const gam = await Gamification.findOne({ user: req.params.id });
    return success(res, 'Gamification fetched', gam);
  } catch (err) { next(err); }
});

// ─── GET /admin/users/:id/orders ─────────────────────────────────────────────
router.get('/users/:id/orders', async (req, res, next) => {
  try {
    const orders = await Order.find({ user: req.params.id })
      .populate('items.product', 'name images')
      .sort({ createdAt: -1 })
      .limit(20);
    return success(res, 'Orders fetched', { orders });
  } catch (err) { next(err); }
});

// ─── GET /admin/users/:id/health ─────────────────────────────────────────────
router.get('/users/:id/health', async (req, res, next) => {
  try {
    const records = await HealthActivity.find({ user: req.params.id }).sort({ date: -1 }).limit(30);
    return success(res, 'Health records fetched', records);
  } catch (err) { next(err); }
});

// ─── GET /admin/shop/orders ───────────────────────────────────────────────────
router.get('/shop/orders', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status = '' } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, parseInt(limit));
    const skip = (pageNum - 1) * limitNum;

    const filter = {};
    if (status) filter.status = status;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('user', 'name email avatarUrl')
        .populate('items.product', 'name images')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Order.countDocuments(filter),
    ]);

    return success(res, 'Orders fetched', {
      orders,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) { next(err); }
});

// ─── PATCH /admin/shop/orders/:id/status ─────────────────────────────────────
router.patch('/shop/orders/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const VALID = ['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
    if (!VALID.includes(status)) return error(res, 'Invalid status', 400);

    const order = await Order.findByIdAndUpdate(req.params.id, { $set: { status } }, { new: true })
      .populate('user', 'name email');
    if (!order) return error(res, 'Order not found', 404);
    return success(res, 'Order status updated', order);
  } catch (err) { next(err); }
});

// ─── GET /admin/shop/coupons ──────────────────────────────────────────────────
router.get('/shop/coupons', async (req, res, next) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    return success(res, 'Coupons fetched', coupons);
  } catch (err) { next(err); }
});

// ─── POST /admin/shop/coupons ─────────────────────────────────────────────────
router.post('/shop/coupons', async (req, res, next) => {
  try {
    const coupon = await Coupon.create(req.body);
    return success(res, 'Coupon created', coupon, 201);
  } catch (err) { next(err); }
});

// ─── PUT /admin/shop/coupons/:id ─────────────────────────────────────────────
router.put('/shop/coupons/:id', async (req, res, next) => {
  try {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true });
    if (!coupon) return error(res, 'Coupon not found', 404);
    return success(res, 'Coupon updated', coupon);
  } catch (err) { next(err); }
});

// ─── DELETE /admin/shop/coupons/:id ──────────────────────────────────────────
router.delete('/shop/coupons/:id', async (req, res, next) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) return error(res, 'Coupon not found', 404);
    return success(res, 'Coupon deleted');
  } catch (err) { next(err); }
});

// ─── POST /admin/shop/products ────────────────────────────────────────────────
router.post('/shop/products', async (req, res, next) => {
  try {
    const product = await Product.create(req.body);
    return success(res, 'Product created', product, 201);
  } catch (err) { next(err); }
});

// ─── PUT /admin/shop/products/:id ────────────────────────────────────────────
router.put('/shop/products/:id', async (req, res, next) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true });
    if (!product) return error(res, 'Product not found', 404);
    return success(res, 'Product updated', product);
  } catch (err) { next(err); }
});

// ─── DELETE /admin/shop/products/:id ─────────────────────────────────────────
router.delete('/shop/products/:id', async (req, res, next) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, { $set: { isActive: false } }, { new: true });
    if (!product) return error(res, 'Product not found', 404);
    return success(res, 'Product deactivated');
  } catch (err) { next(err); }
});

// ─── POST /admin/shop/categories ─────────────────────────────────────────────
router.post('/shop/categories', async (req, res, next) => {
  try {
    const category = await Category.create(req.body);
    return success(res, 'Category created', category, 201);
  } catch (err) { next(err); }
});

// ─── PUT /admin/shop/categories/:id ──────────────────────────────────────────
router.put('/shop/categories/:id', async (req, res, next) => {
  try {
    const category = await Category.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!category) return error(res, 'Category not found', 404);
    return success(res, 'Category updated', category);
  } catch (err) { next(err); }
});

// ─── DELETE /admin/shop/categories/:id ───────────────────────────────────────
router.delete('/shop/categories/:id', async (req, res, next) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) return error(res, 'Category not found', 404);
    return success(res, 'Category deleted');
  } catch (err) { next(err); }
});

// ─── GET /admin/dashboard/stats ──────────────────────────────────────────────
router.get('/dashboard/stats', async (req, res, next) => {
  try {
    const [totalUsers, totalOrders, totalProducts, totalRevenue] = await Promise.all([
      User.countDocuments(),
      Order.countDocuments(),
      Product.countDocuments({ isActive: true }),
      Order.aggregate([
        { $match: { status: { $ne: 'CANCELLED' } } },
        { $group: { _id: null, total: { $sum: '$totalCoins' } } },
      ]),
    ]);

    const revenueCoins = totalRevenue[0]?.total || 0;

    // New users in last 7 days
    const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const newUsers7d = await User.countDocuments({ createdAt: { $gte: since7 } });

    return success(res, 'Dashboard stats fetched', {
      totalUsers,
      totalOrders,
      totalProducts,
      revenueCoins,
      newUsers7d,
    });
  } catch (err) { next(err); }
});

module.exports = router;
