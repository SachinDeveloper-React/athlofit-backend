// src/app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

// BUG-003: Fail fast in production if CLIENT_URL is not configured
if (process.env.NODE_ENV === 'production' && !process.env.CLIENT_URL) {
  throw new Error('CLIENT_URL environment variable is required in production');
}

const authRoutes        = require('./routes/auth.routes');
const userRoutes        = require('./routes/user.routes');
const healthRoutes      = require('./routes/health.routes');
const gamificationRoutes = require('./routes/gamification.routes');
const configRoutes      = require('./routes/config.routes');
const shopRoutes        = require('./routes/shop.routes');
const blogRoutes        = require('./routes/blog.routes');
const paymentRoutes     = require('./routes/payment.routes');
const uploadRoutes      = require('./routes/upload.routes');
const nutritionRoutes   = require('./routes/nutrition.routes');
const referralRoutes    = require('./routes/referral.routes');
const challengeRoutes   = require('./routes/challenge.routes');
const notificationRoutes = require('./routes/notification.routes');
const { handleWebhook } = require('./controllers/payment.controller');
const { errorHandler, notFound } = require('./middleware/error.middleware');

const app = express();

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet());

// Support multiple comma-separated origins (mobile app, admin panel, website)
const allowedOrigins = (process.env.CLIENT_URL || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// ─── Razorpay webhook (must use raw body BEFORE express.json) ────────────────
// Signature verification requires the unparsed request body.
app.post(
  '/payment/webhook',
  express.raw({ type: 'application/json' }),
  handleWebhook,
);

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});
// BUG-002: Exclude /auth from global limiter — auth routes have their own tighter limiter
app.use((req, res, next) => {
  if (req.path.startsWith('/auth')) return next();
  return limiter(req, res, next);
});

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
app.use('/blog',          blogRoutes);
app.use('/payment',       paymentRoutes);
app.use('/upload',        uploadRoutes);
app.use('/nutrition',     nutritionRoutes);
app.use('/referral',      referralRoutes);
app.use('/challenges',    challengeRoutes);
app.use('/notification',  notificationRoutes);
// Phone verification removed — app.use('/phone', phoneRoutes);

// ─── Error handling ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
