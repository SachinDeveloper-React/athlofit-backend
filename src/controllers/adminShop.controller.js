// src/controllers/adminShop.controller.js
// ─── Admin CRUD for products, categories, coupons, and orders ────────────────

const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const Coupon = require('../models/Coupon.model');
const Order = require('../models/Order.model');
const { success, error } = require('../utils/response');
const { uploadImages, uploadImage } = require('../utils/uploadImage');

const slugify = (text) =>
  text.toString().toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

// Parse + sanitize a variants payload (array or JSON string from multipart).
function normalizeVariants(input) {
  if (input === undefined) return undefined; // signal "no change"
  let arr = input;
  if (typeof input === 'string') {
    if (!input.trim()) return [];
    try { arr = JSON.parse(input); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((v) => ({
      size: (v.size || '').toString().trim(),
      color: (v.color || '').toString().trim(),
      stock: Math.max(0, Number(v.stock) || 0),
      sku: (v.sku || '').toString().trim(),
      priceOverride: v.priceOverride != null && v.priceOverride !== ''
        ? Number(v.priceOverride) : null,
    }))
    // drop fully-empty rows
    .filter((v) => v.size || v.color || v.stock || v.sku);
}

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────

const createProduct = async (req, res, next) => {
  try {
    const { name, description, price, category } = req.body;
    if (!name || !description || price === undefined || !category) {
      return error(res, 'name, description, price and category are required', 400);
    }

    // Collect image URLs: uploaded files (multipart) + any provided URLs.
    const uploadedUrls = req.files?.length ? await uploadImages(req.files, 'products') : [];
    let providedUrls = [];
    if (Array.isArray(req.body.images)) providedUrls = req.body.images;
    else if (typeof req.body.images === 'string' && req.body.images.trim()) {
      // Accept JSON array string or comma-separated list
      try { providedUrls = JSON.parse(req.body.images); }
      catch { providedUrls = req.body.images.split(',').map((u) => u.trim()).filter(Boolean); }
    }
    const images = [...providedUrls, ...uploadedUrls];

    // Tags may be array or comma-separated string (multipart)
    let tags = [];
    if (Array.isArray(req.body.tags)) tags = req.body.tags;
    else if (typeof req.body.tags === 'string' && req.body.tags.trim())
      tags = req.body.tags.split(',').map((t) => t.trim()).filter(Boolean);

    const product = await Product.create({
      name,
      description,
      price: Number(price),
      discountedPrice: req.body.discountedPrice != null && req.body.discountedPrice !== ''
        ? Number(req.body.discountedPrice) : null,
      images,
      category,
      stock: Number(req.body.stock) || 0,
      tags,
      isFeatured: req.body.isFeatured === true || req.body.isFeatured === 'true',
      isActive: req.body.isActive !== undefined
        ? (req.body.isActive === true || req.body.isActive === 'true') : true,
      coinReward: Number(req.body.coinReward) || 0,
      variants: normalizeVariants(req.body.variants) || [],
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

    // Newly uploaded image files (multipart)
    const uploadedUrls = req.files?.length ? await uploadImages(req.files, 'products') : [];

    // Existing/kept image URLs sent by the client
    let keptUrls;
    if (req.body.images !== undefined) {
      if (Array.isArray(req.body.images)) keptUrls = req.body.images;
      else if (typeof req.body.images === 'string') {
        try { keptUrls = JSON.parse(req.body.images); }
        catch { keptUrls = req.body.images.split(',').map((u) => u.trim()).filter(Boolean); }
      }
    }

    // Merge: if client provided an images list, use it + new uploads;
    // otherwise just append new uploads to whatever already exists.
    if (keptUrls !== undefined || uploadedUrls.length) {
      const base = keptUrls !== undefined ? keptUrls : product.images;
      product.images = [...base, ...uploadedUrls];
    }

    const fields = ['name', 'description', 'category'];
    for (const f of fields) if (req.body[f] !== undefined) product[f] = req.body[f];

    if (req.body.tags !== undefined) {
      if (Array.isArray(req.body.tags)) product.tags = req.body.tags;
      else if (typeof req.body.tags === 'string')
        product.tags = req.body.tags.split(',').map((t) => t.trim()).filter(Boolean);
    }
    if (req.body.isFeatured !== undefined)
      product.isFeatured = req.body.isFeatured === true || req.body.isFeatured === 'true';
    if (req.body.isActive !== undefined)
      product.isActive = req.body.isActive === true || req.body.isActive === 'true';
    if (req.body.price !== undefined) product.price = Number(req.body.price);
    if (req.body.discountedPrice !== undefined)
      product.discountedPrice = req.body.discountedPrice != null && req.body.discountedPrice !== ''
        ? Number(req.body.discountedPrice) : null;
    if (req.body.stock !== undefined) product.stock = Number(req.body.stock);
    if (req.body.coinReward !== undefined) product.coinReward = Number(req.body.coinReward);

    const normVariants = normalizeVariants(req.body.variants);
    if (normVariants !== undefined) product.variants = normVariants;

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
    const { status, trackingNumber, trackingUrl, carrier, estimatedDelivery, description } = req.body;
    const valid = ['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
    if (!valid.includes(status)) {
      return error(res, `status must be one of: ${valid.join(', ')}`, 400);
    }

    const order = await Order.findById(req.params.id);
    if (!order) return error(res, 'Order not found', 404);

    // Build tracking event title based on status
    const statusTitles = {
      PENDING:   'Order Placed',
      PAID:      'Payment Confirmed',
      SHIPPED:   'Order Shipped',
      DELIVERED: 'Order Delivered',
      CANCELLED: 'Order Cancelled',
    };

    const now = new Date();

    // Update status
    order.status = status;

    // Push tracking history entry
    order.trackingHistory.push({
      status,
      title: statusTitles[status],
      description: description || '',
      timestamp: now,
    });

    // Set timestamp fields
    if (status === 'PAID')      order.paidAt = now;
    if (status === 'SHIPPED')   order.shippedAt = now;
    if (status === 'DELIVERED') order.deliveredAt = now;
    if (status === 'CANCELLED') order.cancelledAt = now;

    // Shipping details (usually set when status = SHIPPED)
    if (trackingNumber) order.trackingNumber = trackingNumber;
    if (trackingUrl)    order.trackingUrl = trackingUrl;
    if (carrier)        order.carrier = carrier;
    if (estimatedDelivery) order.estimatedDelivery = new Date(estimatedDelivery);

    await order.save();
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
