// src/controllers/auth.controller.js
const User = require('../models/User.model');
const Gamification = require('../models/Gamification.model');
const RefreshToken = require('../models/RefreshToken.model');
const admin = require('../config/firebase.admin');
const { generateAccessToken, saveRefreshToken, rotateRefreshToken, revokeAllUserTokens } = require('../utils/jwt');
const { generateOtp, getOtpExpiry, sendOtpEmail } = require('../utils/otp');
const { success, error } = require('../utils/response');
const { OAuth2Client } = require('google-auth-library');

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
    try {
      await sendOtpEmail(email, otp, 'signup');
    } catch (err) {
      console.error('[signup] OTP email send failed:', err.message, err.stack);
      // Account is created — return success but warn about email
      return success(res, 'Account created but email delivery failed. Please use resend OTP.', {
        message: 'OTP email delivery failed',
        status: 'success',
        emailSendFailed: true,
      }, 201);
    }

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

    const accessToken = generateAccessToken(user._id.toString(), user.tokenVersion);
    const refreshToken = await saveRefreshToken(
      user._id,
      req.ip,
      req.headers['user-agent']
    );

    return success(res, 'Email verified successfully', {
      status: 'success',
      message: 'Email verified',
      accessToken,
      refreshToken,
      user: user.toJSON(),
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /auth/user/login ────────────────────────────────────────────────────
const login = async (req, res, next) => {
  try {
    const { email, password, termsAccepted } = req.body;

    // Require terms & conditions acceptance
    if (!termsAccepted) {
      return error(res, 'You must accept the Terms & Conditions and Privacy Policy to log in', 400);
    }
    
    let user = await User.findOne({ email }).select('+password');
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

      try {
        await sendOtpEmail(email, otp, 'signup');
      } catch (mailErr) {
        console.error('OTP send failed on login (unverified):', mailErr.message);
      }

      // Return 403 with a flag so the frontend can navigate to OTP screen
      return res.status(403).json({
        success: false,
        message: 'Email not verified. A new OTP has been sent.',
        data: {
          emailNotVerified: true,
          email: email,
        },
      });
    }

    // Record terms acceptance
    if (!user.termsAccepted) {
      user.termsAccepted = true;
      user.termsAcceptedAt = new Date();
      await user.save();
    }

    // Check if user is already logged in on another device
    const activeSession = await RefreshToken.findOne({
      user: user._id,
      revoked: false,
      expiresAt: { $gt: new Date() },
    });

    if (activeSession) {
      // If the user explicitly requests force login, skip the FCM check
      // and revoke old sessions directly (handles uninstall case where
      // FCM token stays valid for hours after app removal).
      const forceLogin = req.body.forceLogin === true;

      if (forceLogin) {
        await RefreshToken.updateMany(
          { user: user._id, revoked: false },
          { $set: { revoked: true } },
        );
        await User.updateOne(
          { _id: user._id },
          { $set: { fcmToken: null }, $inc: { tokenVersion: 1 } },
        );
        // Refresh user object to get the updated tokenVersion for the new JWT
        user = await User.findById(user._id).select('-password');
      } else {
        // Verify the old device still has the app by sending a silent push
        const oldFcmToken = user.fcmToken;
        let oldDeviceAlive = false;

        if (oldFcmToken) {
          try {
            // Send silent data-only message to check token validity
            await admin.messaging().send({
              token: oldFcmToken,
              data: { type: 'heartbeat', timestamp: String(Date.now()) },
              android: { priority: 'normal' },
              apns: {
                headers: { 'apns-priority': '5' },
                payload: { aps: { 'content-available': 1 } },
              },
            });
            // Token is valid — old device still has the app installed
            oldDeviceAlive = true;
          } catch (fcmErr) {
            const code = fcmErr?.errorInfo?.code || fcmErr?.code;
            if (
              code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token'
            ) {
              // Token is stale — app was uninstalled on old device
              oldDeviceAlive = false;
            } else {
              // Other FCM error (network issue, etc.) — assume device is alive to be safe
              oldDeviceAlive = true;
            }
          }
        }

        if (oldDeviceAlive) {
          // Old device is still active — send alert notification and block login
          try {
            await admin.messaging().send({
              token: oldFcmToken,
              notification: {
                title: 'Login Attempt Detected',
                body: 'Someone is trying to log in to your account from another device. If this wasn\'t you, please secure your account.',
              },
              data: { type: 'SECURITY', screen: 'AccountScreen' },
              android: {
                priority: 'high',
                notification: { channelId: 'athlofit_push', sound: 'default' },
              },
              apns: { payload: { aps: { sound: 'default', badge: 1 } } },
            });
          } catch (_) {
            // Notification send failed — still block the login
          }

          return res.status(409).json({
            success: false,
            message: 'Your account is already logged in on another device. A security alert has been sent to that device.',
            data: { activeSession: true },
          });
        } else {
          // Old device no longer has the app — auto-revoke old sessions and allow login
          await RefreshToken.updateMany(
            { user: user._id, revoked: false },
            { $set: { revoked: true } },
          );
          // Clear stale FCM token
          await User.updateOne(
            { _id: user._id },
            { $set: { fcmToken: null } },
          );
        }
      }
    }

    // Ensure gamification doc exists
    await Gamification.findOneAndUpdate(
      { user: user._id },
      { user: user._id },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const accessToken = generateAccessToken(user._id.toString(), user.tokenVersion);
    const refreshToken = await saveRefreshToken(
      user._id,
      req.ip,
      req.headers['user-agent']
    );

    // Track login timestamp for anti-stale-sync guard
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

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

// ─── POST /auth/admin/login ───────────────────────────────────────────────────
// Admin-only login. Validates credentials and enforces role === 'admin'.
const adminLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return error(res, 'Invalid email or password', 401);
    }

    if (user.role !== 'admin') {
      return error(res, 'Access denied. Admin account required.', 403);
    }

    const accessToken = generateAccessToken(user._id.toString(), user.tokenVersion);
    const refreshToken = await saveRefreshToken(
      user._id,
      req.ip,
      req.headers['user-agent']
    );

    return success(res, 'Login successful', {
      status: 'success',
      message: 'Login successful',
      accessToken,
      refreshToken,
      user: user.toJSON(),
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
    // Clear FCM token so the device is no longer considered "active"
    await User.updateOne(
      { _id: req.user._id },
      { $set: { fcmToken: null } },
    );
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

    if (flow === 'signup' && user.emailVerified) {
      return error(res, 'Email is already verified', 400);
    }

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

// ─── POST /auth/google ────────────────────────────────────────────────────────
const googleLogin = async (req, res, next) => {
  try {
    const { idToken, givenName, familyName, scopes, serverAuthCode, photo, termsAccepted } = req.body;
    if (!idToken) return error(res, 'Google idToken is required', 400);

    // Require terms & conditions acceptance
    if (!termsAccepted) {
      return error(res, 'You must accept the Terms & Conditions and Privacy Policy to log in', 400);
    }

    // Verify idToken — accept both web and Android client IDs as valid audience
    const validAudiences = [
      process.env.GOOGLE_WEB_CLIENT_ID,
      process.env.GOOGLE_ANDROID_CLIENT_ID,
    ].filter(Boolean);

    let payload;
    try {
      // Try web client ID first, then Android client ID
      let lastErr;
      for (const audience of validAudiences) {
        try {
          const client = new OAuth2Client(audience);
          const ticket = await client.verifyIdToken({ idToken, audience });
          payload = ticket.getPayload();
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!payload) throw lastErr;
    } catch (verifyErr) {
      return error(res, 'Invalid Google token', 401);
    }

    const {
      sub: googleId,
      email,
      name,
      picture,
      given_name,
      family_name,
    } = payload;

    if (!email) return error(res, 'Could not retrieve email from Google account', 400);

    // Prefer frontend-provided values (higher resolution photo, etc.)
    const avatarUrl   = photo || picture || null;
    const displayName = name || `${givenName || ''} ${familyName || ''}`.trim() || email.split('@')[0];
    const firstName   = givenName  || given_name  || null;
    const lastName    = familyName || family_name || null;

    // Find or create user
    let user = await User.findOne({ $or: [{ googleId }, { email }] });
    
    if (!user) {
      // ── New user — create account ──────────────────────────────────────────
      user = await User.create({
        name: displayName,
        email,
        googleId,
        provider: 'google',
        emailVerified: true,
        avatarUrl,
        givenName:  firstName,
        familyName: lastName,
        googleScopes: scopes ?? [],
      });

      // Bootstrap gamification record
      await Gamification.findOneAndUpdate(
        { user: user._id },
        { user: user._id },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } else {
      // ── Returning user — refresh profile data from Google ─────────────────
      const updates = {
        googleId,
        provider:      'google',
        emailVerified: true,
        givenName:     firstName,
        familyName:    lastName,
        googleScopes:  scopes ?? [],
      };

      // Only update avatarUrl if Google returned a non-null photo — prevents
      // overwriting a previously set custom avatar with null (BUG-013)
      if (avatarUrl) updates.avatarUrl = avatarUrl;

      // Only update name if user doesn't already have one set
      if (!user.name && displayName) updates.name = displayName;

      // findByIdAndUpdate with { new: true } returns the updated document
      user = await User.findByIdAndUpdate(
        user._id,
        { $set: updates },
        { new: true }
      );
    }

    // Record terms acceptance
    if (!user.termsAccepted) {
      user.termsAccepted = true;
      user.termsAcceptedAt = new Date();
      await user.save();
    }

    // Check if user is already logged in on another device
    const activeSession = await RefreshToken.findOne({
      user: user._id,
      revoked: false,
      expiresAt: { $gt: new Date() },
    });

    if (activeSession) {
      const forceLogin = req.body.forceLogin === true;

      if (forceLogin) {
        await RefreshToken.updateMany(
          { user: user._id, revoked: false },
          { $set: { revoked: true } },
        );
        await User.updateOne(
          { _id: user._id },
          { $set: { fcmToken: null }, $inc: { tokenVersion: 1 } },
        );
        user = await User.findById(user._id).select('-password');
      } else {
        const oldFcmToken = user.fcmToken;
        let oldDeviceAlive = false;

        if (oldFcmToken) {
          try {
            await admin.messaging().send({
              token: oldFcmToken,
              data: { type: 'heartbeat', timestamp: String(Date.now()) },
              android: { priority: 'normal' },
              apns: {
                headers: { 'apns-priority': '5' },
                payload: { aps: { 'content-available': 1 } },
              },
            });
            oldDeviceAlive = true;
          } catch (fcmErr) {
            const code = fcmErr?.errorInfo?.code || fcmErr?.code;
            if (
              code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token'
            ) {
              oldDeviceAlive = false;
            } else {
              oldDeviceAlive = true;
            }
          }
        }

        if (oldDeviceAlive) {
          try {
            await admin.messaging().send({
              token: oldFcmToken,
              notification: {
                title: 'Login Attempt Detected',
                body: 'Someone is trying to log in to your account from another device. If this wasn\'t you, please secure your account.',
              },
              data: { type: 'SECURITY', screen: 'AccountScreen' },
              android: {
                priority: 'high',
                notification: { channelId: 'athlofit_push', sound: 'default' },
              },
              apns: { payload: { aps: { sound: 'default', badge: 1 } } },
            });
          } catch (_) {}

          return res.status(409).json({
            success: false,
            message: 'Your account is already logged in on another device. A security alert has been sent to that device.',
            data: { activeSession: true },
          });
        } else {
          await RefreshToken.updateMany(
            { user: user._id, revoked: false },
            { $set: { revoked: true } },
          );
          await User.updateOne(
            { _id: user._id },
            { $set: { fcmToken: null } },
          );
        }
      }
    }

    const accessToken  = generateAccessToken(user._id.toString(), user.tokenVersion);
    const refreshToken = await saveRefreshToken(user._id, req.ip, req.headers['user-agent']);

    // Track login timestamp for anti-stale-sync guard
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    return success(res, 'Google login successful', {
      status: 'success',
      accessToken,
      refreshToken,
      user: user.toJSON(),
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  signup,
  verifySignupOtp,
  login,
  adminLogin,
  refreshToken,
  logout,
  forgotPassword,
  resendOtp,
  resetPassword,
  googleLogin,
};
