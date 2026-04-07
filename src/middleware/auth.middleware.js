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
