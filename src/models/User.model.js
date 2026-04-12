// src/models/User.model.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// ─── Helper: generate unique 8-char alphanumeric referral code ────────────────
const generateReferralCode = () =>
  crypto.randomBytes(4).toString('hex').toUpperCase();

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
    },
    password: {
      type: String,
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
    },
    provider: {
      type: String,
      enum: ['email', 'google', 'apple'],
      default: 'email',
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },
    isProfileCompleted: { type: Boolean, default: false },

    // Profile fields
    phone: { type: String, default: null },
    dob: { type: String, default: null },        // ISO date "YYYY-MM-DD"
    gender: { type: String, enum: ['M', 'F', 'O', null], default: null },
    height: { type: Number, default: null },     // cm
    weight: { type: Number, default: null },     // kg
    bloodType: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    age: { type: Number, default: null },

    // Unit system preference
    unitSystem: { type: String, enum: ['metric', 'imperial'], default: 'metric' },

    // Google OAuth
    googleId: { type: String, default: null, sparse: true },

    // Referral
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Health goal
    dailyStepGoal: { type: Number, default: 10000 },

    // Saved delivery addresses
    savedAddresses: [
      {
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
        label: { type: String, default: 'Home' },   // "Home", "Work", "Other"
        fullName: { type: String, default: '' },
        phone: { type: String, default: '' },
        street: { type: String, default: '' },
        city: { type: String, default: '' },
        state: { type: String, default: '' },
        zipCode: { type: String, default: '' },
        country: { type: String, default: 'India' },
        isDefault: { type: Boolean, default: false },
      },
    ],

    // OTP fields
    otp: { type: String, select: false },
    otpExpires: { type: Date, select: false },
    otpFlow: { type: String, enum: ['signup', 'forgot_password', null], select: false, default: null },

    // Token versioning (for invalidation)
    tokenVersion: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.password;
        delete ret.otp;
        delete ret.otpExpires;
        delete ret.otpFlow;
        delete ret.tokenVersion;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ─── Pre-save hook: hash password + auto-generate referral code ──────────────
userSchema.pre('save', async function (next) {
  // Hash password if modified
  if (this.isModified('password') && this.password) {
    this.password = await bcrypt.hash(this.password, 12);
  }
  // Auto-generate referral code on first save
  if (!this.referralCode) {
    this.referralCode = generateReferralCode();
  }
  next();
});

// ─── Method: compare password ─────────────────────────────────────────────────
userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('User', userSchema);
