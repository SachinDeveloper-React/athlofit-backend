// src/controllers/phone.controller.js
// Phone number verification via OTP (MSG91)

const User = require('../models/User.model');
const { generateOtp, getOtpExpiry } = require('../utils/otp');
const { sendOtpSms } = require('../utils/sms');
const { success, error } = require('../utils/response');

// ─── POST /phone/send-otp ─────────────────────────────────────────────────────
// Send OTP to the user's phone number for verification.
const sendPhoneOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;
    const userId = req.user._id;

    if (!phone) {
      return error(res, 'Phone number is required', 400);
    }

    // Strip +91 or 91 prefix, keep only digits
    const cleanPhone = phone.replace(/^\+?91/, '').replace(/\D/g, '');
    if (cleanPhone.length !== 10) {
      return error(res, 'Please enter a valid 10-digit phone number', 400);
    }

    const user = await User.findById(userId).select('+otp +otpExpires +otpFlow');
    if (!user) return error(res, 'User not found', 404);

    // Rate limit: don't allow resending within 60 seconds
    if (user.otpExpires && user.otpFlow === 'phone_verify') {
      const timeLeft = user.otpExpires.getTime() - Date.now();
      if (timeLeft > 4 * 60 * 1000) {
        // OTP was sent less than 60s ago (expiry is 5 min, so > 4 min remaining means < 1 min since send)
        return error(res, 'Please wait before requesting another OTP', 429);
      }
    }

    const otp = generateOtp();

    // Save OTP and phone on user
    user.phone = cleanPhone;
    user.otp = otp;
    user.otpExpires = getOtpExpiry();
    user.otpFlow = 'phone_verify';
    await user.save();

    console.log(`[Phone] Sending OTP to ${cleanPhone}`);
    // Send SMS via MSG91
    const smsResult = await sendOtpSms(cleanPhone, otp);

    if (!smsResult.success) {
      return error(res, smsResult.message || 'Failed to send OTP. Please try again.', 500);
    }

    return success(res, 'OTP sent to your phone number', {
      phone: cleanPhone.slice(-4).padStart(10, '*'), // mask: ******1234
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /phone/verify-otp ───────────────────────────────────────────────────
// Verify the OTP and mark phone as verified.
const verifyPhoneOtp = async (req, res, next) => {
  try {
    const { otp } = req.body;
    const userId = req.user._id;

    if (!otp) {
      return error(res, 'OTP is required', 400);
    }

    const user = await User.findById(userId).select('+otp +otpExpires +otpFlow');
    if (!user) return error(res, 'User not found', 404);

    if (user.otpFlow !== 'phone_verify') {
      return error(res, 'No phone verification in progress', 400);
    }

    if (!user.otp || user.otp !== otp) {
      return error(res, 'Invalid OTP', 400);
    }

    if (user.otpExpires < new Date()) {
      return error(res, 'OTP expired. Please request a new one.', 400);
    }

    // Mark phone as verified
    user.phoneVerified = true;
    user.otp = undefined;
    user.otpExpires = undefined;
    user.otpFlow = null;
    await user.save();

    return success(res, 'Phone number verified successfully', {
      phoneVerified: true,
      phone: user.phone,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { sendPhoneOtp, verifyPhoneOtp };
