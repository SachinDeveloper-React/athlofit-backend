// src/models/Referral.model.js
const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema(
  {
    referrer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    referee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true, // Each referee can only use one referral code
    },
    referralCode: {
      type: String,
      required: true,
    },
    referrerBonusAwarded: { type: Boolean, default: false },
    referrerBonus: { type: Number, default: 100 },
    refereeBonusAwarded: { type: Boolean, default: false },
    refereeBonus: { type: Number, default: 50 },
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

// Index for fast lookup
referralSchema.index({ referrer: 1 });
referralSchema.index({ referralCode: 1 });

module.exports = mongoose.model('Referral', referralSchema);
