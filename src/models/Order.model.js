// src/models/Order.model.js
const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  coinPrice: { type: Number, required: true },
  quantity: { type: Number, required: true, min: 1 },
  // Selected variant (if the product has variants)
  variant: {
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    size: { type: String, default: '' },
    color: { type: String, default: '' },
  },
});

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: [orderItemSchema],
    totalPrice: { type: Number, required: true },
    totalCoins: { type: Number, default: 0 },
    paymentMethod: {
      type: String,
      enum: ['STANDARD', 'COIN_PURCHASE', 'RAZORPAY'],
      default: 'STANDARD',
    },
    status: {
      type: String,
      enum: ['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED'],
      default: 'PAID', // Default PAID since coins are deducted instantly
    },
    // ── Razorpay payment fields ──────────────────────────────────────────────
    payment: {
      razorpayOrderId:   { type: String, default: null, index: true },
      razorpayPaymentId: { type: String, default: null },
      razorpaySignature: { type: String, default: null },
      status: {
        type: String,
        enum: ['CREATED', 'CAPTURED', 'FAILED', 'REFUNDED'],
        default: 'CREATED',
      },
    },
    // Guest contact (for non-logged-in website purchases, if allowed)
    contactEmail: { type: String, default: null },
    contactPhone: { type: String, default: null },
    shippingAddress: {
      street:  { type: String, required: true },  // BUG-039
      city:    { type: String, required: true },
      state:   { type: String, required: true },
      zipCode: { type: String, required: true },
      country: { type: String, default: 'India' },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Indexes for common query patterns
orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
