// src/models/Coupon.model.js
const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    description: { type: String, default: '' },

    // Discount type
    discountType: {
      type: String,
      enum: ['percentage', 'flat_coins'],
      required: true,
    },
    // For percentage: 0–100. For flat_coins: exact coin amount off.
    discountValue: { type: Number, required: true, min: 0 },

    // Optional cap on percentage discounts (max coins saved)
    maxDiscountCoins: { type: Number, default: null },

    // Minimum cart total in coins to apply this coupon
    minCartCoins: { type: Number, default: 0 },

    // Validity window
    validFrom: { type: Date, default: Date.now },
    validUntil: { type: Date, default: null }, // null = no expiry

    // Usage limits
    usageLimit: { type: Number, default: null },   // null = unlimited
    usageCount: { type: Number, default: 0 },
    perUserLimit: { type: Number, default: 1 },    // max uses per user

    // Track which users have used this coupon
    usedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  },
);

couponSchema.index({ code: 1 });

module.exports = mongoose.model('Coupon', couponSchema);
