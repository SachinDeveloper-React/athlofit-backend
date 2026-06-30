// src/controllers/payment.controller.js
// ─── Razorpay order creation, verification, and webhook handling ─────────────

const Product = require('../models/Product.model');
const Order = require('../models/Order.model');
const { success, error } = require('../utils/response');
const {
  getRazorpay,
  verifyPaymentSignature,
  verifyWebhookSignature,
} = require('../utils/razorpay');
const { createNotification } = require('../utils/createNotification');
const { getCachedConfig } = require('../utils/configCache');
const { resolveNotification } = require('../utils/notificationTemplates');

// ─── POST /payment/create-order ──────────────────────────────────────────────
// Creates a Razorpay order for the given cart items and a PENDING local order.
// Body: { items: [{ productId, quantity }], shippingAddress, contactEmail, contactPhone }
const createPaymentOrder = async (req, res, next) => {
  try {
    const razorpay = getRazorpay();
    if (!razorpay) {
      return error(res, 'Online payments are not configured', 503);
    }

    const { items, shippingAddress, contactEmail, contactPhone } = req.body;
    if (!items || items.length === 0) {
      return error(res, 'Cart is empty', 400);
    }
    if (
      !shippingAddress ||
      !shippingAddress.street ||
      !shippingAddress.city ||
      !shippingAddress.state ||
      !shippingAddress.zipCode
    ) {
      return error(res, 'Complete shipping address is required', 400);
    }

    let totalPrice = 0;
    const orderItems = [];
    const cfg = await getCachedConfig();
    const coinRate = cfg?.coin?.conversionRate ?? 10;

    // Validate products + stock, compute server-side total (never trust client)
    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product || !product.isActive) {
        return error(res, `Product ${item.productId} unavailable`, 400);
      }

      let activePrice = product.discountedPrice !== null ? product.discountedPrice : product.price;
      let variantInfo = { variantId: null, size: '', color: '' };

      if (product.hasVariants && product.variants.length) {
        if (!item.variantId) {
          return error(res, `Please select a variant for ${product.name}`, 400);
        }
        const variant = product.variants.id(item.variantId);
        if (!variant) return error(res, `Selected variant unavailable for ${product.name}`, 400);
        if (variant.stock < item.quantity) {
          return error(res, `Insufficient stock for ${product.name} (${[variant.size, variant.color].filter(Boolean).join('/')})`, 400);
        }
        if (variant.priceOverride != null) activePrice = variant.priceOverride;
        variantInfo = { variantId: variant._id, size: variant.size, color: variant.color };
      } else if (product.stock < item.quantity) {
        return error(res, `Insufficient stock for ${product.name}`, 400);
      }

      totalPrice += activePrice * item.quantity;
      orderItems.push({
        product: product._id,
        name: product.name,
        price: activePrice,
        coinPrice: activePrice * coinRate,
        quantity: item.quantity,
        variant: variantInfo,
      });
    }

    if (totalPrice <= 0) {
      return error(res, 'Invalid order total', 400);
    }

    // Razorpay expects amount in the smallest currency unit (paise)
    const amountInPaise = Math.round(totalPrice * 100);

    const rzpOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`,
      notes: {
        userId: req.user?._id?.toString() || 'guest',
      },
    });

    // Persist a PENDING order tied to the Razorpay order id
    const order = await Order.create({
      user: req.user._id,
      items: orderItems,
      totalPrice,
      totalCoins: 0,
      paymentMethod: 'RAZORPAY',
      status: 'PENDING',
      shippingAddress,
      contactEmail: contactEmail || req.user.email || null,
      contactPhone: contactPhone || null,
      payment: {
        razorpayOrderId: rzpOrder.id,
        status: 'CREATED',
      },
    });

    return success(res, 'Payment order created', {
      orderId: order._id,
      razorpayOrderId: rzpOrder.id,
      amount: amountInPaise,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /payment/verify ──────────────────────────────────────────────────────
// Verifies the checkout signature and finalizes the order (decrements stock).
// Body: { razorpayOrderId, razorpayPaymentId, razorpaySignature }
const verifyPayment = async (req, res, next) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return error(res, 'Missing payment verification fields', 400);
    }

    const isValid = verifyPaymentSignature({
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      signature: razorpaySignature,
    });

    if (!isValid) {
      return error(res, 'Payment signature verification failed', 400);
    }

    const order = await Order.findOne({
      'payment.razorpayOrderId': razorpayOrderId,
      user: req.user._id,
    });

    if (!order) return error(res, 'Order not found', 404);

    // Idempotency: if already captured, just return success
    if (order.payment.status === 'CAPTURED') {
      return success(res, 'Payment already verified', { order });
    }

    // Finalize: decrement stock + mark paid using atomic operations
    // (No transaction needed – each findOneAndUpdate is atomic per-document)
    const decrementedProducts = [];
    try {
      for (const item of order.items) {
        if (item.variant?.variantId) {
          const r = await Product.updateOne(
            { _id: item.product, 'variants._id': item.variant.variantId, 'variants.stock': { $gte: item.quantity } },
            { $inc: { 'variants.$.stock': -item.quantity, stock: -item.quantity } },
          );
          if (r.matchedCount === 0) throw new Error(`Insufficient stock for ${item.name}`);
        } else {
          const updated = await Product.findOneAndUpdate(
            { _id: item.product, stock: { $gte: item.quantity } },
            { $inc: { stock: -item.quantity } },
            { new: true },
          );
          if (!updated) throw new Error(`Insufficient stock for ${item.name}`);
        }
        decrementedProducts.push(item);
      }

      order.status = 'PAID';
      order.payment.razorpayPaymentId = razorpayPaymentId;
      order.payment.razorpaySignature = razorpaySignature;
      order.payment.status = 'CAPTURED';
      await order.save();
    } catch (stockErr) {
      // Rollback: restore stock for any products already decremented
      for (const item of decrementedProducts) {
        if (item.variant?.variantId) {
          await Product.updateOne(
            { _id: item.product, 'variants._id': item.variant.variantId },
            { $inc: { 'variants.$.stock': item.quantity, stock: item.quantity } },
          );
        } else {
          await Product.findOneAndUpdate(
            { _id: item.product },
            { $inc: { stock: item.quantity } },
          );
        }
      }
      throw stockErr;
    }

    const shortId = order._id.toString().slice(-6).toUpperCase();
    const tpl = await resolveNotification('orderConfirmed', { orderId: shortId });
    createNotification(req.user._id, {
      type: 'PRODUCT',
      title: tpl?.title || '🛍️ Order Confirmed!',
      message: tpl?.message || `Your order #${shortId} has been placed successfully.`,
      data: { screen: 'OrderHistory' },
    });

    return success(res, 'Payment verified and order confirmed', { order });
  } catch (err) {
    next(err);
  }
};

// ─── POST /payment/webhook ──────────────────────────────────────────────────────
// Razorpay server-to-server webhook. Mounted with a raw body parser.
// Handles payment.captured and payment.failed events as a safety net.
const handleWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    // req.body is a Buffer here (raw parser)
    const rawBody = req.body;

    if (!verifyWebhookSignature(rawBody, signature)) {
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    const event = payload.event;
    const entity = payload.payload?.payment?.entity;

    if (entity?.order_id) {
      const order = await Order.findOne({ 'payment.razorpayOrderId': entity.order_id });
      if (order) {
        if (event === 'payment.captured' && order.payment.status !== 'CAPTURED') {
          order.payment.razorpayPaymentId = entity.id;
          order.payment.status = 'CAPTURED';
          if (order.status === 'PENDING') order.status = 'PAID';
          await order.save();
        } else if (event === 'payment.failed') {
          order.payment.status = 'FAILED';
          await order.save();
        }
      }
    }

    // Always 200 so Razorpay stops retrying once received
    return res.status(200).json({ success: true });
  } catch (err) {
    // Log but still 200 to avoid infinite retries on parse errors
    console.error('Razorpay webhook error:', err.message);
    return res.status(200).json({ success: true });
  }
};

module.exports = {
  createPaymentOrder,
  verifyPayment,
  handleWebhook,
};
