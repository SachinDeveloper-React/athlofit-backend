// src/app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes        = require('./routes/auth.routes');
const userRoutes        = require('./routes/user.routes');
const healthRoutes      = require('./routes/health.routes');
const gamificationRoutes = require('./routes/gamification.routes');
const configRoutes      = require('./routes/config.routes');
const shopRoutes        = require('./routes/shop.routes');
const nutritionRoutes   = require('./routes/nutrition.routes');
const referralRoutes    = require('./routes/referral.routes');
const challengeRoutes   = require('./routes/challenge.routes');
const notificationRoutes = require('./routes/notification.routes');
const { errorHandler, notFound } = require('./middleware/error.middleware');

const app = express();

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  credentials: true,
}));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});
// app.use(limiter);

// Auth endpoints get tighter limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many auth requests, please try again later.' },
});

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Logging ──────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Athlofit API is running 🏃',
    version: '1.0.0',
    environment: process.env.NODE_ENV,
    isMaintenance: process.env.MAINTENANCE_MODE === 'true',
  });
});

// ─── Maintenance Mode Middleware ──────────────────────────────────────────────
app.use((req, res, next) => {
  if (process.env.MAINTENANCE_MODE === 'true') {
    return res.status(503).json({
      success: false,
      message: 'Service is currently under maintenance. We will be back shortly!',
      isMaintenance: true,
    });
  }
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/auth',          authLimiter, authRoutes);
app.use('/user',          userRoutes);
app.use('/health',        healthRoutes);
app.use('/gamification',  gamificationRoutes);
app.use('/config',        configRoutes);
app.use('/shop',          shopRoutes);
app.use('/nutrition',     nutritionRoutes);
app.use('/referral',      referralRoutes);
app.use('/challenges',    challengeRoutes);
app.use('/notification',  notificationRoutes);

// ─── Error handling ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
