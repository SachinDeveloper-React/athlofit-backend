// src/controllers/payment.controller.js
// ─── Razorpay order creation, verification, and webhook handling ─────────────

const mongoose = require('mongoose');
const Product = require('../models/Product.model');
const Order = require('../models/Order.model');
const { success, error } = require('../utils/response');
const {
  getRazorpay,
  verifyPaymentSignature,
  verifyWebhookSignature,
} = require('../utils/razorpay');
const { createNotification } = require('../utils/createNotification');

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

    // Validate products + stock, compute server-side total (never trust client)
    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product || !product.isActive) {
        return error(res, `Product ${item.productId} unavailable`, 400);
      }
      if (product.stock < item.quantity) {
        return error(res, `Insufficient stock for ${product.name}`, 400);
      }
      const activePrice =
        product.discountedPrice !== null ? product.discountedPrice : product.price;
      totalPrice += activePrice * item.quantity;
      orderItems.push({
        product: product._id,
        name: product.name,
        price: activePrice,
        coinPrice: activePrice * 10,
        quantity: item.quantity,
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

    // Finalize: decrement stock + mark paid inside a transaction
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      for (const item of order.items) {
        const updated = await Product.findOneAndUpdate(
          { _id: item.product, stock: { $gte: item.quantity } },
          { $inc: { stock: -item.quantity } },
          { session, new: true },
        );
        if (!updated) {
          throw new Error(`Insufficient stock for ${item.name}`);
        }
      }

      order.status = 'PAID';
      order.payment.razorpayPaymentId = razorpayPaymentId;
      order.payment.razorpaySignature = razorpaySignature;
      order.payment.status = 'CAPTURED';
      await order.save({ session });

      await session.commitTransaction();
    } catch (txErr) {
      await session.abortTransaction();
      throw txErr;
    } finally {
      session.endSession();
    }

    createNotification(req.user._id, {
      type: 'PRODUCT',
      title: '🛍️ Order Confirmed!',
      message: `Your order #${order._id.toString().slice(-6).toUpperCase()} has been placed successfully.`,
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
