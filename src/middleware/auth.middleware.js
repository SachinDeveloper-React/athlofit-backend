// src/middleware/auth.middleware.js
const { verifyAccessToken } = require('../utils/jwt');
const User = require('../models/User.model');
const { error } = require('../utils/response');

const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, 'Authentication token missing', 401);
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);

    const user = await User.findById(decoded.sub).select('-password');
    if (!user) {
      return error(res, 'User not found', 401);
    }

    // Verify token version — rejects tokens issued before a forced logout
    if (decoded.tv !== undefined && decoded.tv !== user.tokenVersion) {
      return error(res, 'Session expired. Please log in again.', 401);
    }

    // Block banned/suspended accounts (admins are exempt).
    if (user.isBanned && user.role !== 'admin') {
      return error(
        res,
        user.banInfo?.reason
          ? `Account suspended: ${user.banInfo.reason}`
          : 'Your account has been suspended. Contact support.',
        403,
      );
    }

    // Track last activity (fire-and-forget, throttled to once per 5 min to reduce DB writes)
    const FIVE_MINUTES = 5 * 60 * 1000;
    if (!user.lastActiveAt || Date.now() - user.lastActiveAt.getTime() > FIVE_MINUTES) {
      User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return error(res, 'Token expired', 401);
    }
    return error(res, 'Invalid token', 401);
  }
};

const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return error(res, 'Access denied', 403);
  }
  next();
};

module.exports = { protect, adminOnly };
