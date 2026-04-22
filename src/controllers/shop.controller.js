// src/controllers/shop.controller.js
const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const Order = require('../models/Order.model');
const Gamification = require('../models/Gamification.model');
const { success, error } = require('../utils/response');
const User = require('../models/User.model');

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

    // Search filter
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { tags: { $in: [new RegExp(search, 'i')] } },
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
        { name: { $regex: q, $options: 'i' } },
        { tags: { $in: [new RegExp(q, 'i')] } },
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
    const { items, shippingAddress } = req.body;
    // items: [{ productId, quantity }]
    
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

    if (gamification.coinsBalance < totalCoinCost) {
      return error(res, `Insufficient coins. Need ${totalCoinCost} but you have ${gamification.coinsBalance}.`, 400);
    }

    // Deduct stock
    for (const item of items) {
      await Product.findByIdAndUpdate(item.productId, { $inc: { stock: -item.quantity } });
    }

    // Deduct coins
    gamification.coinsBalance -= totalCoinCost;
    await gamification.save();

    // Create Order
    const order = await Order.create({
      user: req.user._id,
      items: orderItems,
      totalPrice: totalStandardPrice,
      totalCoins: totalCoinCost,
      paymentMethod: 'COIN_PURCHASE',
      status: 'PAID',
      shippingAddress: shippingAddress || {},
    });

    return success(res, 'Purchase successful using coins!', {
      order,
      remainingCoins: gamification.coinsBalance,
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
        gam.coinsBalance += order.totalCoins;
        await gam.save();
        refundedCoins = order.totalCoins;
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

    return success(res, 'Order cancelled successfully', {
      orderId: order._id,
      status: order.status,
      refundedCoins,
    });
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
  getOrders,
  cancelOrder,
};

