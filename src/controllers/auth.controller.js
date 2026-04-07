// src/controllers/auth.controller.js
const User = require('../models/User.model');
const Gamification = require('../models/Gamification.model');
const { generateAccessToken, saveRefreshToken, rotateRefreshToken, revokeAllUserTokens } = require('../utils/jwt');
const { generateOtp, getOtpExpiry, sendOtpEmail } = require('../utils/otp');
const { success, error } = require('../utils/response');

// ─── POST /auth/user/signup ───────────────────────────────────────────────────
const signup = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    const existing = await User.findOne({ email });
    if (existing) {
      return error(res, 'Email already registered', 409);
    }

    const otp = generateOtp();
    const user = await User.create({
      name,
      email,
      password,
      otp,
      otpExpires: getOtpExpiry(),
      otpFlow: 'signup',
    });

    // Send verification OTP
    await sendOtpEmail(email, otp, 'signup').catch(err =>
      console.error('OTP send failed:', err.message)
    );

    return success(res, 'Account created. Please verify your email with the OTP sent.', {
      message: 'OTP sent to email',
      status: 'success',
    }, 201);
  } catch (err) {
    next(err);
  }
};

// ─── POST /auth/user/signup-verify ───────────────────────────────────────────
const verifySignupOtp = async (req, res, next) => {
  try {
    const { email, otp, flow } = req.body;

    const user = await User.findOne({ email }).select('+otp +otpExpires +otpFlow');
    if (!user) return error(res, 'User not found', 404);

    if (user.otpFlow !== flow) return error(res, 'Invalid OTP flow', 400);
    if (!user.otp || user.otp !== otp) return error(res, 'Invalid OTP', 400);
    if (user.otpExpires < new Date()) return error(res, 'OTP expired', 400);

    // Mark verified
    user.emailVerified = true;
    user.otp = undefined;
    user.otpExpires = undefined;
    user.otpFlow = null;
    await user.save();

    // Bootstrap gamification record
    await Gamification.findOneAndUpdate(
      { user: user._id },
      { user: user._id },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const accessToken = generateAccessToken(user._id.toString());
    const refreshToken = await saveRefreshToken(
      user._id,
      req.ip,
      req.headers['user-agent']
    );

    console.log("   accessToken, refreshToken, user,", accessToken, refreshToken, user)
    return success(res, 'Email verified successfully', {
      status: 'success',
      message: 'Email verified',
      accessToken,
      refreshToken,
      user,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /auth/user/login ────────────────────────────────────────────────────
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return error(res, 'Invalid email or password', 401);
    }

    if (!user.emailVerified) {
      // Resend OTP
      const otp = generateOtp();
      user.otp = otp;
      user.otpExpires = getOtpExpiry();
      user.otpFlow = 'signup';
      await user.save();
      await sendOtpEmail(email, otp, 'signup').catch(() => {});
      return error(res, 'Email not verified. A new OTP has been sent.', 403);
    }

    // Ensure gamification doc exists
    await Gamification.findOneAndUpdate(
      { user: user._id },
      { user: user._id },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const accessToken = generateAccessToken(user._id.toString());
    const refreshToken = await saveRefreshToken(
      user._id,
      req.ip,
      req.headers['user-agent']
    );

    // Remove password from response by running toJSON transform
    const userObj = user.toJSON();

    return success(res, 'Login successful', {
      status: 'success',
      message: 'Login successful',
      accessToken,
      refreshToken,
      user: userObj,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /auth/user/refresh-token ───────────────────────────────────────────
const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) return error(res, 'Refresh token required', 400);

    const result = await rotateRefreshToken(token, req.ip, req.headers['user-agent']);
    if (!result) return error(res, 'Invalid or expired refresh token', 401);

    return success(res, 'Token refreshed', {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /auth/logout ────────────────────────────────────────────────────────
const logout = async (req, res, next) => {
  try {
    await revokeAllUserTokens(req.user._id);
    return success(res, 'Logged out successfully');
  } catch (err) {
    next(err);
  }
};

// ─── POST /auth/forgot-password ──────────────────────────────────────────────
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    // Always return success (prevent email enumeration)
    if (!user) {
      return success(res, 'If that email exists, an OTP has been sent.');
    }

    const otp = generateOtp();
    user.otp = otp;
    user.otpExpires = getOtpExpiry();
    user.otpFlow = 'forgot_password';
    await user.save();

    await sendOtpEmail(email, otp, 'forgot_password').catch(err =>
      console.error('OTP send failed:', err.message)
    );

    return success(res, 'If that email exists, an OTP has been sent.');
  } catch (err) {
    next(err);
  }
};

// ─── POST /auth/resend-otp ────────────────────────────────────────────────────
const resendOtp = async (req, res, next) => {
  try {
    const { email, flow } = req.body;

    const user = await User.findOne({ email });
    if (!user) return error(res, 'User not found', 404);

    const otp = generateOtp();
    user.otp = otp;
    user.otpExpires = getOtpExpiry();
    user.otpFlow = flow;
    await user.save();

    await sendOtpEmail(email, otp, flow).catch(err =>
      console.error('OTP send failed:', err.message)
    );

    return success(res, 'OTP resent successfully');
  } catch (err) {
    next(err);
  }
};

// ─── POST /auth/reset-password ────────────────────────────────────────────────
const resetPassword = async (req, res, next) => {
  try {
    const { email, otp, password } = req.body;

    const user = await User.findOne({ email }).select('+otp +otpExpires +otpFlow');
    if (!user) return error(res, 'User not found', 404);

    if (user.otpFlow !== 'forgot_password') return error(res, 'Invalid OTP flow', 400);
    if (!user.otp || user.otp !== otp) return error(res, 'Invalid OTP', 400);
    if (user.otpExpires < new Date()) return error(res, 'OTP expired', 400);

    user.password = password;
    user.otp = undefined;
    user.otpExpires = undefined;
    user.otpFlow = null;
    user.tokenVersion += 1; // Invalidate old tokens
    await user.save();

    await revokeAllUserTokens(user._id);

    return success(res, 'Password reset successfully');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  signup,
  verifySignupOtp,
  login,
  refreshToken,
  logout,
  forgotPassword,
  resendOtp,
  resetPassword,
};
