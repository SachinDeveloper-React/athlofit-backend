// src/controllers/adminShop.controller.js
// ─── Admin CRUD for products, categories, coupons, and orders ────────────────

const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const Coupon = require('../models/Coupon.model');
const Order = require('../models/Order.model');
const { success, error } = require('../utils/response');

const slugify = (text) =>
  text.toString().toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────

const createProduct = async (req, res, next) => {
  try {
    const { name, description, price, category } = req.body;
    if (!name || !description || price === undefined || !category) {
      return error(res, 'name, description, price and category are required', 400);
    }
    const product = await Product.create({
      name,
      description,
      price: Number(price),
      discountedPrice: req.body.discountedPrice != null ? Number(req.body.discountedPrice) : null,
      images: Array.isArray(req.body.images) ? req.body.images : [],
      category,
      stock: Number(req.body.stock) || 0,
      tags: Array.isArray(req.body.tags) ? req.body.tags : [],
      isFeatured: !!req.body.isFeatured,
      isActive: req.body.isActive !== undefined ? !!req.body.isActive : true,
      coinReward: Number(req.body.coinReward) || 0,
    });
    return success(res, 'Product created', product, 201);
  } catch (err) {
    next(err);
  }
};

const updateProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return error(res, 'Product not found', 404);

    const fields = ['name', 'description', 'images', 'category', 'tags', 'isFeatured', 'isActive'];
    for (const f of fields) if (req.body[f] !== undefined) product[f] = req.body[f];
    if (req.body.price !== undefined) product.price = Number(req.body.price);
    if (req.body.discountedPrice !== undefined)
      product.discountedPrice = req.body.discountedPrice != null ? Number(req.body.discountedPrice) : null;
    if (req.body.stock !== undefined) product.stock = Number(req.body.stock);
    if (req.body.coinReward !== undefined) product.coinReward = Number(req.body.coinReward);

    await product.save();
    return success(res, 'Product updated', product);
  } catch (err) {
    next(err);
  }
};

const deleteProduct = async (req, res, next) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return error(res, 'Product not found', 404);
    return success(res, 'Product deleted', { id: req.params.id });
  } catch (err) {
    next(err);
  }
};

// ─── CATEGORIES ─────────────────────────────────────────────────────────────

const createCategory = async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return error(res, 'name is required', 400);
    const category = await Category.create({
      name,
      slug: req.body.slug ? slugify(req.body.slug) : slugify(name),
      icon: req.body.icon || 'Tag',
      color: req.body.color || '#0099FF',
      description: req.body.description || '',
      isActive: req.body.isActive !== undefined ? !!req.body.isActive : true,
    });
    return success(res, 'Category created', category, 201);
  } catch (err) {
    next(err);
  }
};

const updateCategory = async (req, res, next) => {
  try {
    const updates = {};
    for (const f of ['name', 'icon', 'color', 'description', 'isActive']) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    if (req.body.slug) updates.slug = slugify(req.body.slug);
    else if (req.body.name) updates.slug = slugify(req.body.name);

    const category = await Category.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true },
    );
    if (!category) return error(res, 'Category not found', 404);
    return success(res, 'Category updated', category);
  } catch (err) {
    next(err);
  }
};

const deleteCategory = async (req, res, next) => {
  try {
    const inUse = await Product.countDocuments({ category: req.params.id });
    if (inUse > 0) {
      return error(res, `Cannot delete: ${inUse} product(s) use this category`, 400);
    }
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) return error(res, 'Category not found', 404);
    return success(res, 'Category deleted', { id: req.params.id });
  } catch (err) {
    next(err);
  }
};

// ─── COUPONS ──────────────────────────────────────────────────────────────────

const getCoupons = async (req, res, next) => {
  try {
    const coupons = await Coupon.find({}).sort({ createdAt: -1 });
    return success(res, 'Coupons fetched', coupons);
  } catch (err) {
    next(err);
  }
};

const createCoupon = async (req, res, next) => {
  try {
    const { code, discountType, discountValue } = req.body;
    if (!code || !discountType || discountValue === undefined) {
      return error(res, 'code, discountType and discountValue are required', 400);
    }
    const coupon = await Coupon.create({
      code: code.toUpperCase().trim(),
      description: req.body.description || '',
      discountType,
      discountValue: Number(discountValue),
      maxDiscountCoins: req.body.maxDiscountCoins != null ? Number(req.body.maxDiscountCoins) : null,
      minCartCoins: Number(req.body.minCartCoins) || 0,
      validFrom: req.body.validFrom || Date.now(),
      validUntil: req.body.validUntil || null,
      usageLimit: req.body.usageLimit != null ? Number(req.body.usageLimit) : null,
      perUserLimit: Number(req.body.perUserLimit) || 1,
      isActive: req.body.isActive !== undefined ? !!req.body.isActive : true,
    });
    return success(res, 'Coupon created', coupon, 201);
  } catch (err) {
    next(err);
  }
};

const updateCoupon = async (req, res, next) => {
  try {
    const updates = {};
    const fields = [
      'description', 'discountType', 'discountValue', 'maxDiscountCoins',
      'minCartCoins', 'validFrom', 'validUntil', 'usageLimit', 'perUserLimit', 'isActive',
    ];
    for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];
    if (req.body.code) updates.code = req.body.code.toUpperCase().trim();

    const coupon = await Coupon.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true },
    );
    if (!coupon) return error(res, 'Coupon not found', 404);
    return success(res, 'Coupon updated', coupon);
  } catch (err) {
    next(err);
  }
};

const deleteCoupon = async (req, res, next) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) return error(res, 'Coupon not found', 404);
    return success(res, 'Coupon deleted', { id: req.params.id });
  } catch (err) {
    next(err);
  }
};

// ─── ORDERS ─────────────────────────────────────────────────────────────────

const getOrders = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, parseInt(limit, 10));
    const skip = (pageNum - 1) * limitNum;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('user', 'name email')
        .populate('items.product', 'name images')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Order.countDocuments(filter),
    ]);

    return success(res, 'Orders fetched', {
      orders,
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

const updateOrderStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const valid = ['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
    if (!valid.includes(status)) {
      return error(res, `status must be one of: ${valid.join(', ')}`, 400);
    }
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true },
    );
    if (!order) return error(res, 'Order not found', 404);
    return success(res, 'Order status updated', order);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createProduct,
  updateProduct,
  deleteProduct,
  createCategory,
  updateCategory,
  deleteCategory,
  getCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  getOrders,
  updateOrderStatus,
};
