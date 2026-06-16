// src/controllers/shop.controller.js
const mongoose = require('mongoose');
const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const Order = require('../models/Order.model');
const Gamification = require('../models/Gamification.model');
const { success, error } = require('../utils/response');
const User = require('../models/User.model');
const { sendPushToUser } = require('../utils/pushNotification');
const { createNotification } = require('../utils/createNotification');
const { logCoinTransaction } = require('../utils/logCoinTransaction');

// BUG-032: Escape regex special characters to prevent ReDoS
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Conversion Rate: 10 Coins = 1 INR
const COIN_CONVERSION_RATE = 10;

// ─── GET /shop/categories ─────────────────────────────────────────────────────
const getCategories = async (req, res, next) => {
  try {
    const categories = await Category.find({ isActive: true })
      .populate('productCount')
      .sort({ name: 1 });

    return success(res, 'Categories fetched', categories);
  } catch (err) {
    next(err);
  }
};

// ─── GET /shop/products ───────────────────────────────────────────────────────
// Query: ?category=slug&page=1&limit=20&sort=newest|price_asc|price_desc|rating&search=term
const getProducts = async (req, res, next) => {
  try {
    const { category, page = 1, limit = 20, sort = 'newest', search } = req.query;

    const filter = { isActive: true };

    // Category filter by slug
    if (category && category !== 'all') {
      const cat = await Category.findOne({ slug: category });
      if (cat) filter.category = cat._id;
    }

    // Search filter — BUG-032: escape user input before using in $regex
    if (search) {
      const safeSearch = escapeRegex(search);
      filter.$or = [
        { name: { $regex: safeSearch, $options: 'i' } },
        { description: { $regex: safeSearch, $options: 'i' } },
        { tags: { $in: [new RegExp(safeSearch, 'i')] } },
      ];
    }

    // Sort
    let sortObj = {};
    switch (sort) {
      case 'price_asc':   sortObj = { price: 1 }; break;
      case 'price_desc':  sortObj = { price: -1 }; break;
      case 'rating':      sortObj = { rating: -1 }; break;
      case 'newest':
      default:            sortObj = { createdAt: -1 }; break;
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, parseInt(limit));
    const skip = (pageNum - 1) * limitNum;

    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate('category', 'name slug color icon')
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum)
        .select('-reviews'),
      Product.countDocuments(filter),
    ]);

    return success(res, 'Products fetched', {
      products,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        hasMore: pageNum < Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /shop/products/featured ─────────────────────────────────────────────
const getFeaturedProducts = async (req, res, next) => {
  try {
    const products = await Product.find({ isActive: true, isFeatured: true })
      .populate('category', 'name slug color icon')
      .sort({ createdAt: -1 })
      .limit(10)
      .select('-reviews');

    return success(res, 'Featured products fetched', products);
  } catch (err) {
    next(err);
  }
};

// ─── GET /shop/products/:id ───────────────────────────────────────────────────
const getProductById = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate('category', 'name slug color icon')
      .populate('reviews.user', 'name avatarUrl');

    if (!product || !product.isActive) {
      return error(res, 'Product not found', 404);
    }

    return success(res, 'Product fetched', product);
  } catch (err) {
    next(err);
  }
};

// ─── POST /shop/products/:id/review ──────────────────────────────────────────
const addReview = async (req, res, next) => {
  try {
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return error(res, 'Rating must be between 1 and 5', 400);
    }

    const product = await Product.findById(req.params.id);
    if (!product || !product.isActive) {
      return error(res, 'Product not found', 404);
    }

    // Remove existing review from same user
    product.reviews = product.reviews.filter(
      r => r.user.toString() !== req.user._id.toString()
    );

    product.reviews.push({ user: req.user._id, rating, comment });
    product.updateRating();
    await product.save();

    return success(res, 'Review submitted', {
      rating: product.rating,
      reviewCount: product.reviewCount,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /shop/products/:id/reviews ──────────────────────────────────────────
// Query: ?page=1&limit=10
const getProductReviews = async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const pageNum  = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, parseInt(limit, 10));
    const skip     = (pageNum - 1) * limitNum;

    const product = await Product.findById(req.params.id)
      .select('reviews rating reviewCount')
      .populate('reviews.user', 'name avatarUrl');

    if (!product) return error(res, 'Product not found', 404);

    const total    = product.reviews.length;
    const sorted   = [...product.reviews].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const paginated = sorted.slice(skip, skip + limitNum);

    // Rating breakdown (1–5 star counts)
    const breakdown = [1, 2, 3, 4, 5].reduce((acc, star) => {
      acc[star] = product.reviews.filter(r => r.rating === star).length;
      return acc;
    }, {});

    return success(res, 'Reviews fetched', {
      reviews: paginated,
      rating: product.rating,
      reviewCount: product.reviewCount,
      breakdown,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        hasMore: skip + limitNum < total,
      },
    });
  } catch (err) {
    next(err);
  }
};
const searchProducts = async (req, res, next) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.trim().length < 2) {
      return error(res, 'Search query must be at least 2 characters', 400);
    }

    const products = await Product.find({
      isActive: true,
      $or: [
        { name: { $regex: escapeRegex(q), $options: 'i' } },  // BUG-032
        { tags: { $in: [new RegExp(escapeRegex(q), 'i')] } },
      ],
    })
      .populate('category', 'name slug color icon')
      .limit(parseInt(limit))
      .select('-reviews');

    return success(res, 'Search results', products);
  } catch (err) {
    next(err);
  }
};

// ─── POST /shop/cart/buy-with-coins ──────────────────────────────────────────
const buyWithCoins = async (req, res, next) => {
  try {
    const { items, shippingAddress, couponCode } = req.body;

    // Require email verification before purchase
    if (!req.user.emailVerified) {
      return error(res, 'Please verify your email before making a purchase', 403);
    }
    
    if (!items || items.length === 0) {
      return error(res, 'Cart is empty', 400);
    }

    const gamification = await Gamification.findOne({ user: req.user._id });
    if (!gamification) {
      return error(res, 'User gamification profile not found', 404);
    }

    let totalStandardPrice = 0;
    let totalCoinCost = 0;
    const orderItems = [];

    // Verify products, stock, and calculate costs
    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product || !product.isActive) {
        return error(res, `Product ${item.productId} unavailable`, 400);
      }
      if (product.stock < item.quantity) {
        return error(res, `Insufficient stock for ${product.name}`, 400);
      }

      const activePrice = product.discountedPrice !== null ? product.discountedPrice : product.price;
      const itemCoinPrice = activePrice * COIN_CONVERSION_RATE;
      
      totalStandardPrice += activePrice * item.quantity;
      totalCoinCost += itemCoinPrice * item.quantity;
      
      orderItems.push({
        product: product._id,
        name: product.name,
        price: activePrice,
        coinPrice: itemCoinPrice,
        quantity: item.quantity,
      });
    }

    // ── Apply coupon if provided ──────────────────────────────────────────────
    let couponDiscount = 0;
    let appliedCoupon = null;
    if (couponCode) {
      const Coupon = require('../models/Coupon.model');
      const coupon = await Coupon.findOne({ code: couponCode.toUpperCase().trim(), isActive: true });

      if (!coupon) return error(res, 'Invalid or expired coupon code', 400);

      const now = new Date();
      if (coupon.validUntil && coupon.validUntil < now) return error(res, 'Coupon has expired', 400);
      if (coupon.validFrom > now) return error(res, 'Coupon is not yet active', 400);
      if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) return error(res, 'Coupon usage limit reached', 400);
      if (totalCoinCost < coupon.minCartCoins) return error(res, `Minimum cart value of ${coupon.minCartCoins} coins required`, 400);

      const userUseCount = coupon.usedBy.filter(id => id.toString() === req.user._id.toString()).length;
      if (userUseCount >= coupon.perUserLimit) return error(res, 'You have already used this coupon', 400);

      if (coupon.discountType === 'percentage') {
        couponDiscount = Math.round(totalCoinCost * (coupon.discountValue / 100));
        if (coupon.maxDiscountCoins !== null) couponDiscount = Math.min(couponDiscount, coupon.maxDiscountCoins);
      } else {
        couponDiscount = Math.min(coupon.discountValue, totalCoinCost);
      }

      appliedCoupon = coupon;
    }

    const finalCoinCost = Math.max(0, totalCoinCost - couponDiscount);

    if (gamification.coinsBalance < finalCoinCost) {
      return error(res, `Insufficient coins. Need ${finalCoinCost} but you have ${gamification.coinsBalance}.`, 400);
    }

    // BUG-029: Wrap stock decrement, coin deduction, and order creation in a
    // MongoDB transaction so any failure rolls back all changes atomically.
    const session = await mongoose.startSession();
    session.startTransaction();
    let order;
    try {
      // Deduct stock
      for (const item of items) {
        await Product.findByIdAndUpdate(item.productId, { $inc: { stock: -item.quantity } }, { session });
      }

      // BUG-030: Use Math.round to prevent floating-point drift in coin balance
      gamification.coinsBalance = Math.round(gamification.coinsBalance - finalCoinCost);
      await gamification.save({ session });

      // Mark coupon as used
      if (appliedCoupon) {
        appliedCoupon.usageCount += 1;
        appliedCoupon.usedBy.push(req.user._id);
        await appliedCoupon.save({ session });
      }

      // Create Order
      [order] = await Order.create([{
        user: req.user._id,
        items: orderItems,
        totalPrice: totalStandardPrice,
        totalCoins: finalCoinCost,
        couponCode: appliedCoupon?.code || null,
        couponDiscount,
        paymentMethod: 'COIN_PURCHASE',
        status: 'PAID',
        shippingAddress: shippingAddress || {},
      }], { session });

      await session.commitTransaction();
    } catch (txErr) {
      await session.abortTransaction();
      throw txErr;
    } finally {
      session.endSession();
    }

    // Log coin transaction for purchase
    logCoinTransaction({
      userId: req.user._id,
      type: 'SPENT',
      amount: finalCoinCost,
      balanceAfter: gamification.coinsBalance,
      source: 'SHOP_PURCHASE',
      description: `Shop Purchase — Order #${order._id.toString().slice(-6).toUpperCase()}`,
      metadata: { orderId: order._id },
    });

    // ── Persist + push: order confirmed ──────────────────────────────────
    createNotification(req.user._id, {
      type:    'PRODUCT',
      title:   '🛍️ Order Confirmed!',
      message: `Your order #${order._id.toString().slice(-6).toUpperCase()} has been placed successfully.`,
      data:    { screen: 'OrderHistory' },
    });

    return success(res, 'Purchase successful using coins!', {
      order,
      remainingCoins: gamification.coinsBalance,
      couponDiscount,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /shop/orders ────────────────────────────────────────────────────────
const getOrders = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, parseInt(limit));
    const skip = (pageNum - 1) * limitNum;

    const [orders, total] = await Promise.all([
      Order.find({ user: req.user._id })
        .populate('items.product', 'name images')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Order.countDocuments({ user: req.user._id }),
    ]);

    return success(res, 'Orders fetched', {
      orders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        hasMore: pageNum < Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /shop/orders/:orderId/cancel ──────────────────────────────────────
// Cancels a PENDING or PAID order. Refunds coins for COIN_PURCHASE orders
// and restores product stock.
const cancelOrder = async (req, res, next) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({ _id: orderId, user: req.user._id });

    if (!order) {
      return error(res, 'Order not found', 404);
    }

    // Only allow cancellation of PENDING or PAID orders
    if (!['PENDING', 'PAID'].includes(order.status)) {
      return error(
        res,
        `Order cannot be cancelled. Current status: ${order.status}`,
        400,
      );
    }

    order.status = 'CANCELLED';
    await order.save();

    // ── Refund coins if it was a coin purchase ───────────────────────────────
    let refundedCoins = 0;
    if (order.paymentMethod === 'COIN_PURCHASE' && order.totalCoins > 0) {
      const gam = await Gamification.findOne({ user: req.user._id });
      if (gam) {
        // BUG-031: Use Math.round to prevent floating-point drift in coin balance
        gam.coinsBalance = Math.round(gam.coinsBalance + order.totalCoins);
        await gam.save();
        refundedCoins = order.totalCoins;

        // Log refund transaction
        logCoinTransaction({
          userId: req.user._id,
          type: 'REFUND',
          amount: order.totalCoins,
          balanceAfter: gam.coinsBalance,
          source: 'SHOP_REFUND',
          description: `Refund — Order #${order._id.toString().slice(-6).toUpperCase()} cancelled`,
          metadata: { orderId: order._id },
        });
      }
    }

    // ── Restore product stock ────────────────────────────────────────────────
    for (const item of order.items) {
      if (item.product) {
        await Product.findByIdAndUpdate(item.product, {
          $inc: { stock: item.quantity },
        });
      }
    }

    // ── Persist + push: order cancelled ──────────────────────────────────
    const shortId = order._id.toString().slice(-6).toUpperCase();
    createNotification(req.user._id, {
      type:    'PRODUCT',
      title:   '❌ Order Cancelled',
      message: refundedCoins > 0
        ? `Order #${shortId} cancelled. ${refundedCoins} coins have been refunded.`
        : `Your order #${shortId} has been cancelled.`,
      data:    { screen: 'OrderHistory' },
    });

    return success(res, 'Order cancelled successfully', {
      orderId: order._id,
      status: order.status,
      refundedCoins,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /shop/coupons/validate ─────────────────────────────────────────────
// Validates a coupon code against the current cart total (in coins).
// Returns discount amount without applying it — used for preview in CartScreen.
const validateCoupon = async (req, res, next) => {
  try {
    const { code, cartTotalCoins } = req.body;

    if (!code) return error(res, 'Coupon code is required', 400);

    const Coupon = require('../models/Coupon.model');
    const coupon = await Coupon.findOne({ code: code.toUpperCase().trim(), isActive: true });

    if (!coupon) return error(res, 'Invalid coupon code', 400);

    const now = new Date();
    if (coupon.validUntil && coupon.validUntil < now) return error(res, 'Coupon has expired', 400);
    if (coupon.validFrom > now) return error(res, 'Coupon is not yet active', 400);
    if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) return error(res, 'Coupon usage limit reached', 400);

    const cartTotal = Number(cartTotalCoins) || 0;
    if (cartTotal < coupon.minCartCoins) {
      return error(res, `Minimum cart value of ${coupon.minCartCoins} coins required for this coupon`, 400);
    }

    const userUseCount = coupon.usedBy.filter(id => id.toString() === req.user._id.toString()).length;
    if (userUseCount >= coupon.perUserLimit) return error(res, 'You have already used this coupon', 400);

    let discountCoins = 0;
    if (coupon.discountType === 'percentage') {
      discountCoins = Math.round(cartTotal * (coupon.discountValue / 100));
      if (coupon.maxDiscountCoins !== null) discountCoins = Math.min(discountCoins, coupon.maxDiscountCoins);
    } else {
      discountCoins = Math.min(coupon.discountValue, cartTotal);
    }

    return success(res, `Coupon applied! You save ${discountCoins} coins.`, {
      code: coupon.code,
      description: coupon.description,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discountCoins,
      finalTotal: Math.max(0, cartTotal - discountCoins),
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /shop/coupons ────────────────────────────────────────────────────────
// Returns all active coupons available to the current user.
// Excludes coupons the user has already exhausted their per-user limit on.
const getAvailableCoupons = async (req, res, next) => {
  try {
    const Coupon = require('../models/Coupon.model');
    const now = new Date();

    const coupons = await Coupon.find({
      isActive: true,
      validFrom: { $lte: now },
      $and: [
        { $or: [{ validUntil: null }, { validUntil: { $gt: now } }] },
        { $or: [{ usageLimit: null }, { $expr: { $lt: ['$usageCount', '$usageLimit'] } }] },
      ],
    }).lean(); // BUG-033: single query including usedBy and perUserLimit — no second round-trip

    // Filter out coupons the user has already used up their per-user limit.
    const userId = req.user._id.toString();

    const available = coupons
      .map(c => {
        const userUseCount = (c.usedBy || []).filter(id => id.toString() === userId).length;
        if (userUseCount >= c.perUserLimit) return null;
        // Strip usedBy from the response to avoid leaking other user IDs
        const { usedBy, ...rest } = c;
        return { ...rest, alreadyUsed: false };
      })
      .filter(Boolean);

    return success(res, 'Coupons fetched', available);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getCategories,
  getProducts,
  getFeaturedProducts,
  getProductById,
  getProductReviews,
  addReview,
  searchProducts,
  buyWithCoins,
  validateCoupon,
  getAvailableCoupons,
  getOrders,
  cancelOrder,
};

