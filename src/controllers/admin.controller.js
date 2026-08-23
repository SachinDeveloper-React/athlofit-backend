// src/controllers/admin.controller.js
// ─── Admin management endpoints (users, dashboard) ───────────────────────────

const User = require('../models/User.model');
const Order = require('../models/Order.model');
const Product = require('../models/Product.model');
const Gamification = require('../models/Gamification.model');
const HealthActivity = require('../models/HealthActivity.model');
const Achievement = require('../models/Achievement.model');
const AppConfig = require('../models/AppConfig.model');
const CoinTransaction = require('../models/CoinTransaction.model');
const RefreshToken = require('../models/RefreshToken.model');
const AdminActionLog = require('../models/AdminActionLog.model');
const { success, error } = require('../utils/response');
const { createNotification } = require('../utils/createNotification');
const { DEFAULT_REASON } = require('../utils/stepsTracking');
const { purgeUserData } = require('../utils/purgeUserData');
const { processAccountDeletions } = require('../crons/accountDeletion');
const SyncLog = require('../models/SyncLog.model');

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Record an admin action to the audit log (fire-and-forget safe).
async function logAdminAction(req, targetUser, action, reason = '', metadata = {}) {
  try {
    await AdminActionLog.create({
      admin: req.user._id,
      adminName: req.user.name || '',
      targetUser,
      action,
      reason,
      metadata,
    });
  } catch (err) {
    console.error('[logAdminAction] failed:', err.message);
  }
}

// Lightweight user-agent parser → { device, os, browser }
function parseUserAgent(ua = '') {
  const s = ua.toLowerCase();
  let os = 'Unknown OS';
  if (/iphone|ipad|ios/.test(s)) os = 'iOS';
  else if (/android/.test(s)) os = 'Android';
  else if (/windows/.test(s)) os = 'Windows';
  else if (/mac os|macintosh/.test(s)) os = 'macOS';
  else if (/linux/.test(s)) os = 'Linux';

  let browser = 'App / Unknown';
  if (/okhttp|dart|expo|reactnative/.test(s)) browser = 'Mobile App';
  else if (/edg/.test(s)) browser = 'Edge';
  else if (/chrome/.test(s)) browser = 'Chrome';
  else if (/firefox/.test(s)) browser = 'Firefox';
  else if (/safari/.test(s)) browser = 'Safari';

  const device = /mobile|iphone|android/.test(s) ? 'Mobile' : 'Desktop';
  return { device, os, browser };
}

// ─── GET /admin/users ─────────────────────────────────────────────────────────
// Query: ?page=1&limit=20&search=&role=
const getUsers = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      role,
      // Build / device filters — "who is still on the old version?"
      appVersion,
      platform,
      // 'on' | 'off' — filter by the step-tracking kill switch.
      stepsTracking,
    } = req.query;
    const filter = {};
    if (role) filter.role = role;
    if (search) {
      const safe = escapeRegex(search);
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { email: { $regex: safe, $options: 'i' } },
      ];
    }

    if (appVersion) {
      // 'unknown' selects users who have never sent a version header — i.e.
      // still running a pre-telemetry build, or dormant since before it shipped.
      filter['device.appVersion'] =
        appVersion === 'unknown' ? null : String(appVersion).trim();
    }
    if (platform && ['android', 'ios'].includes(String(platform).toLowerCase())) {
      filter['device.platform'] = String(platform).toLowerCase();
    }
    if (stepsTracking === 'off') {
      filter['stepsTracking.enabled'] = false;
    } else if (stepsTracking === 'on') {
      // Users who predate the field have no sub-document at all, and they are
      // enabled by schema default — $ne:false rather than true catches both.
      filter['stepsTracking.enabled'] = { $ne: false };
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, parseInt(limit, 10));
    const skip = (pageNum - 1) * limitNum;

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('-password -otp -otpExpires')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      User.countDocuments(filter),
    ]);

    return success(res, 'Users fetched', {
      users,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id ───────────────────────────────────────────────────
const getUserById = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select('-password -otp -otpExpires');
    if (!user) return error(res, 'User not found', 404);
    return success(res, 'User fetched', user);
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /admin/users/:id/role ─────────────────────────────────────────────
const updateUserRole = async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!['user', 'admin'].includes(role)) {
      return error(res, 'Role must be "user" or "admin"', 400);
    }
    // Prevent an admin from demoting themselves (avoids lockout)
    if (req.params.id === req.user._id.toString() && role !== 'admin') {
      return error(res, 'You cannot change your own admin role', 400);
    }
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { role } },
      { new: true },
    ).select('-password -otp -otpExpires');
    if (!user) return error(res, 'User not found', 404);
    await logAdminAction(req, user._id, 'ROLE_CHANGE', `Changed role to ${role}`, { role });
    return success(res, 'User role updated', user);
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /admin/users/:id ──────────────────────────────────────────────────
const deleteUser = async (req, res, next) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return error(res, 'You cannot delete your own account', 400);
    }
    const user = await User.findById(req.params.id).select('_id email');
    if (!user) return error(res, 'User not found', 404);

    // Full purge, not just User + Gamification.
    //
    // This used to be `findByIdAndDelete` plus a Gamification cleanup, which
    // left the user's health history, coin ledger, notifications, refresh
    // tokens, meal logs, BMI records, referrals and challenge progress behind
    // as orphans keyed to an id that no longer resolved — data that could not
    // be found, could not be deleted, and still contained their information.
    // It now runs exactly the same purge as the scheduled deletion job, so an
    // admin delete and a user-requested delete leave the same state.
    const result = await purgeUserData(user._id);

    await logAdminAction(req, req.params.id, 'DELETE', req.body?.reason || '', {
      deleted: result.deleted,
      errors: result.errors,
    });

    if (result.errors.length > 0) {
      // Reported rather than swallowed: a half-purged account needs a human to
      // look at it, and returning 200 would hide that.
      return error(
        res,
        `User partially deleted — ${result.errors.length} step(s) failed: ${result.errors.join('; ')}`,
        500,
      );
    }

    return success(res, 'User deleted', { id: req.params.id, deleted: result.deleted });
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/health ─────────────────────────────────────────────
// Returns recent daily activity + summary totals. Coins come from the
// CoinTransaction ledger (the real source of truth), NOT a steps estimate.
const getUserHealth = async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const userOid = new mongoose.Types.ObjectId(req.params.id);

    const activities = await HealthActivity.find({ user: req.params.id })
      .sort({ date: -1 })
      .limit(60);

    // Step-related coin sources from the ledger.
    const STEP_SOURCES = ['PASSIVE_STEPS', 'DAILY_STEP_GOAL', 'DAILY_STEP_GOAL_AUTO'];

    // Aggregate lifetime health totals
    const [agg, earnedAgg, stepCoinAgg, perDayCoins] = await Promise.all([
      HealthActivity.aggregate([
        { $match: { user: userOid } },
        {
          $group: {
            _id: null,
            totalSteps: { $sum: '$steps' },
            totalDistance: { $sum: '$distance' },
            totalCalories: { $sum: '$calories' },
            totalHydration: { $sum: '$hydration' },
            daysTracked: { $sum: 1 },
            goalsMet: { $sum: { $cond: ['$goalMet', 1, 0] } },
          },
        },
      ]),
      // Total coins ever earned (all sources)
      CoinTransaction.aggregate([
        { $match: { user: userOid, type: 'EARNED' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      // Total coins earned specifically from steps
      CoinTransaction.aggregate([
        { $match: { user: userOid, type: 'EARNED', source: { $in: STEP_SOURCES } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      // Coins earned per calendar day (grouped by metadata.date if present,
      // else the IST calendar day of createdAt — matches HealthActivity.date
      // which is always an IST "YYYY-MM-DD" string).
      CoinTransaction.aggregate([
        { $match: { user: userOid, type: 'EARNED' } },
        {
          $group: {
            _id: {
              $ifNull: [
                '$metadata.date',
                { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
              ],
            },
            total: { $sum: '$amount' },
            stepTotal: {
              $sum: { $cond: [{ $in: ['$source', STEP_SOURCES] }, '$amount', 0] },
            },
          },
        },
      ]),
    ]);

    // Round to 2 decimals — passive step coins are fractional (e.g. 0.5/100
    // steps). Math.round() would misreport 37.5 as 38.
    const round2 = (n) => Math.round(((n || 0) + Number.EPSILON) * 100) / 100;

    const totals = agg[0] || {
      totalSteps: 0, totalDistance: 0, totalCalories: 0,
      totalHydration: 0, daysTracked: 0, goalsMet: 0,
    };

    // Map of date -> coins earned that day
    const coinsByDate = {};
    for (const d of perDayCoins) {
      coinsByDate[d._id] = { total: d.total, step: d.stepTotal };
    }

    // Decorate each day with REAL coins earned (from the ledger).
    const days = activities.map((a) => {
      const obj = a.toJSON();
      const c = coinsByDate[a.date] || { total: 0, step: 0 };
      obj.coinsEarned = round2(c.total);   // all coins earned that day
      obj.stepCoins = round2(c.step);      // coins from steps that day
      return obj;
    });

    return success(res, 'User health fetched', {
      days,
      summary: {
        ...totals,
        totalCoinsEarned: round2(earnedAgg[0]?.total || 0),
        totalStepCoins: round2(stepCoinAgg[0]?.total || 0),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/achievements ───────────────────────────────────────
// Returns all achievements with the user's claim status + progress.
const getUserAchievements = async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const userId = req.params.id;

    const [achievements, gam, healthAgg, ordersCount] = await Promise.all([
      Achievement.find({}).sort({ targetValue: 1 }),
      Gamification.findOne({ user: userId }),
      HealthActivity.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(userId) } },
        {
          $group: {
            _id: null,
            totalSteps: { $sum: '$steps' },
            totalWater: { $sum: '$hydration' },
            maxDailySteps: { $max: '$steps' },
          },
        },
      ]),
      Order.countDocuments({ user: userId, status: { $ne: 'CANCELLED' } }),
    ]);

    const stats = healthAgg[0] || { totalSteps: 0, totalWater: 0, maxDailySteps: 0 };
    const claimedIds = new Set(
      (gam?.claimedAchievements || []).map((c) => c.achievementId?.toString()),
    );

    const currentFor = (type) => {
      switch (type) {
        case 'STEPS_TOTAL': return stats.totalSteps;
        case 'STEPS_DAILY': return stats.maxDailySteps;
        case 'WATER_TOTAL': return stats.totalWater;
        case 'ORDERS_COUNT': return ordersCount;
        default: return 0;
      }
    };

    const result = achievements.map((a) => {
      const current = currentFor(a.criteriaType);
      const claimed = claimedIds.has(a._id.toString());
      return {
        _id: a._id,
        key: a.key,
        title: a.title,
        description: a.description,
        reward: a.reward,
        icon: a.icon,
        criteriaType: a.criteriaType,
        targetValue: a.targetValue,
        current,
        progress: Math.min(100, Math.round((current / a.targetValue) * 100)),
        achieved: current >= a.targetValue,
        claimed,
      };
    });

    return success(res, 'User achievements fetched', result);
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/gamification ───────────────────────────────────────
const getUserGamification = async (req, res, next) => {
  try {
    const gam = await Gamification.findOne({ user: req.params.id });
    if (!gam) return success(res, 'No gamification record', null);

    // Attach badge definitions so the admin sees titles/emojis, not just keys.
    let badges = [];
    try {
      const BadgeDefinition = require('../models/BadgeDefinition.model');
      const defs = await BadgeDefinition.find({}).sort({ order: 1 });
      badges = gam.getBadgeList(defs);
    } catch {
      badges = gam.badgeList || [];
    }

    const data = gam.toJSON();
    data.badges = badges;
    return success(res, 'User gamification fetched', data);
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/orders ─────────────────────────────────────────────
const getUserOrders = async (req, res, next) => {
  try {
    const orders = await Order.find({ user: req.params.id })
      .populate('items.product', 'name images')
      .sort({ createdAt: -1 });
    return success(res, 'User orders fetched', orders);
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /admin/users/:id ───────────────────────────────────────────────────
// Edit core account fields: name, verification flags, step goal.
const updateUserAccount = async (req, res, next) => {
  try {
    const allowed = ['name', 'emailVerified', 'phoneVerified', 'dailyStepGoal', 'isProfileCompleted'];
    const updates = {};
    for (const f of allowed) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    if (Object.keys(updates).length === 0) {
      return error(res, 'No valid fields to update', 400);
    }
    if (updates.dailyStepGoal !== undefined) {
      const g = Number(updates.dailyStepGoal);
      if (!Number.isFinite(g) || g < 0) return error(res, 'Invalid step goal', 400);
      updates.dailyStepGoal = g;
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true },
    ).select('-password -otp -otpExpires');
    if (!user) return error(res, 'User not found', 404);
    await logAdminAction(req, user._id, 'ACCOUNT_EDIT', '', updates);
    return success(res, 'User account updated', user);
  } catch (err) {
    next(err);
  }
};

// ─── POST /admin/users/:id/coins ──────────────────────────────────────────────
// Manually credit or debit a user's coin balance. Body: { amount, reason }
// Positive amount = credit, negative = debit. Logged to the CoinTransaction ledger.
const adjustUserCoins = async (req, res, next) => {
  try {
    const { amount, reason } = req.body;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt === 0) {
      return error(res, 'amount must be a non-zero number', 400);
    }

    const gam = await Gamification.findOne({ user: req.params.id });
    if (!gam) return error(res, 'User gamification record not found', 404);

    const newBalance = Math.round((gam.coinsBalance || 0) + amt);
    if (newBalance < 0) {
      return error(res, `Insufficient balance. Current: ${gam.coinsBalance}, requested debit: ${Math.abs(amt)}`, 400);
    }

    gam.coinsBalance = newBalance;
    await gam.save();

    // Log to the ledger so analytics stay accurate.
    const { logCoinTransaction } = require('../utils/logCoinTransaction');
    await logCoinTransaction({
      userId: req.params.id,
      type: amt > 0 ? 'EARNED' : 'SPENT',
      amount: Math.abs(amt),
      balanceAfter: newBalance,
      source: 'MANUAL',
      description: reason?.trim() || `Admin ${amt > 0 ? 'credit' : 'debit'} by ${req.user.name}`,
      metadata: { date: require('../utils/date').todayISO() },
    });

    await logAdminAction(req, req.params.id, amt > 0 ? 'COIN_CREDIT' : 'COIN_DEBIT', reason?.trim() || '', { amount: amt });

    return success(res, `Coins ${amt > 0 ? 'credited' : 'debited'} successfully`, {
      coinsBalance: newBalance,
      adjustment: amt,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /admin/users/:id/add-steps ─────────────────────────────────────────
// Credit bonus steps to a user's account. Body: { steps, reason, date?, source? }
// Steps are added to the user's daily total and logged to BonusSteps history.
const addBonusSteps = async (req, res, next) => {
  try {
    const BonusSteps = require('../models/BonusSteps.model');
    const { steps, reason, date, source } = req.body;

    const stepsNum = Number(steps);
    if (!Number.isFinite(stepsNum) || stepsNum < 1) {
      return error(res, 'steps must be a positive number (minimum 1)', 400);
    }
    if (!reason || reason.trim().length < 3) {
      return error(res, 'reason is required (minimum 3 characters)', 400);
    }

    const targetUser = await User.findById(req.params.id);
    if (!targetUser) return error(res, 'User not found', 404);

    // Use provided date or today
    const today = new Date();
    const effectiveDate = date || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // Create the bonus steps record
    const bonus = await BonusSteps.create({
      user: req.params.id,
      steps: stepsNum,
      date: effectiveDate,
      reason: reason.trim(),
      source: source || 'admin',
      addedBy: req.user._id,
    });

    // Also add bonus steps to the HealthActivity record for that day
    // so the daily total reflects them in challenges and goal checks.
    const existing = await HealthActivity.findOne({ user: req.params.id, date: effectiveDate });
    if (existing) {
      existing.bonusSteps = (existing.bonusSteps || 0) + stepsNum;
      existing.steps = (existing.steps || 0) + stepsNum;
      existing.goalMet = existing.steps >= (targetUser.dailyStepGoal || 10000);
      await existing.save();
    } else {
      await HealthActivity.create({
        user: req.params.id,
        date: effectiveDate,
        steps: stepsNum,
        bonusSteps: stepsNum,
        goalMet: stepsNum >= (targetUser.dailyStepGoal || 10000),
        goalSnapshot: targetUser.dailyStepGoal || 10000,
      });
    }

    // Send a notification to the user
    const { createNotification } = require('../utils/createNotification');
    createNotification(req.params.id, {
      type: 'GENERAL',
      title: '🎁 Bonus Steps Credited!',
      message: `${stepsNum.toLocaleString()} steps were added to your account: "${reason.trim()}"`,
      data: { screen: 'Tracker' },
    });

    await logAdminAction(req, req.params.id, 'BONUS_STEPS', reason.trim(), { steps: stepsNum, date: effectiveDate });

    return success(res, 'Bonus steps added successfully', {
      bonusId: bonus._id,
      steps: stepsNum,
      date: effectiveDate,
      reason: reason.trim(),
      totalStepsForDay: existing ? existing.steps : stepsNum,
    });
  } catch (err) {
    next(err);
  }
};
const resetUserStreak = async (req, res, next) => {
  try {
    const gam = await Gamification.findOneAndUpdate(
      { user: req.params.id },
      { $set: { streakDays: 0 } },
      { new: true },
    );
    if (!gam) return error(res, 'User gamification record not found', 404);
    await logAdminAction(req, req.params.id, 'STREAK_RESET', req.body?.reason || '');
    return success(res, 'Streak reset', { streakDays: gam.streakDays });
  } catch (err) {
    next(err);
  }
};

// ─── POST /admin/users/:id/ban ────────────────────────────────────────────────
// Body: { reason }. Bans the user and revokes all their sessions.
const banUser = async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (req.params.id === req.user._id.toString()) {
      return error(res, 'You cannot ban your own account', 400);
    }
    const user = await User.findById(req.params.id);
    if (!user) return error(res, 'User not found', 404);
    if (user.role === 'admin') return error(res, 'Cannot ban an admin account', 400);

    user.isBanned = true;
    user.banInfo = { reason: reason?.trim() || 'Violation of terms', bannedAt: new Date(), bannedBy: req.user._id };
    user.tokenVersion = (user.tokenVersion || 0) + 1; // invalidate access tokens
    await user.save();

    // Revoke all refresh tokens so the user is logged out everywhere.
    await RefreshToken.updateMany({ user: user._id, revoked: false }, { $set: { revoked: true } });

    await logAdminAction(req, user._id, 'BAN', user.banInfo.reason);

    return success(res, 'User banned', { id: user._id, isBanned: true, banInfo: user.banInfo });
  } catch (err) {
    next(err);
  }
};

// ─── POST /admin/users/:id/unban ──────────────────────────────────────────────
const unbanUser = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return error(res, 'User not found', 404);

    user.isBanned = false;
    user.banInfo = { reason: null, bannedAt: null, bannedBy: null };
    await user.save();

    await logAdminAction(req, user._id, 'UNBAN', reason?.trim() || '');

    return success(res, 'User unbanned', { id: user._id, isBanned: false });
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/sessions ────────────────────────────────────────────
// Lists active (non-revoked, non-expired) sessions/devices for the user.
const getUserSessions = async (req, res, next) => {
  try {
    const now = new Date();
    const tokens = await RefreshToken.find({
      user: req.params.id,
      revoked: false,
      expiresAt: { $gt: now },
    }).sort({ createdAt: -1 });

    const sessions = tokens.map((t) => ({
      id: t._id,
      ip: t.ip || 'unknown',
      userAgent: t.userAgent || '',
      ...parseUserAgent(t.userAgent),
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
    }));

    return success(res, 'Sessions fetched', sessions);
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /admin/users/:id/sessions/:sessionId ──────────────────────────────
// Revoke a single device session.
const revokeUserSession = async (req, res, next) => {
  try {
    const tok = await RefreshToken.findOneAndUpdate(
      { _id: req.params.sessionId, user: req.params.id },
      { $set: { revoked: true } },
      { new: true },
    );
    if (!tok) return error(res, 'Session not found', 404);
    await logAdminAction(req, req.params.id, 'SESSION_REVOKE', '', { sessionId: req.params.sessionId });
    return success(res, 'Session revoked', { id: req.params.sessionId });
  } catch (err) {
    next(err);
  }
};

// ─── POST /admin/users/:id/sessions/revoke-all ────────────────────────────────
// Force logout from all devices (also bumps tokenVersion to kill access tokens).
const revokeAllUserSessions = async (req, res, next) => {
  try {
    await RefreshToken.updateMany({ user: req.params.id, revoked: false }, { $set: { revoked: true } });
    await User.updateOne({ _id: req.params.id }, { $inc: { tokenVersion: 1 } });
    await logAdminAction(req, req.params.id, 'SESSION_REVOKE_ALL', req.body?.reason || '');
    return success(res, 'All sessions revoked — user logged out everywhere', {});
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/action-log ──────────────────────────────────────────
// Returns the admin-action history for a user.
const getUserActionLog = async (req, res, next) => {
  try {
    const logs = await AdminActionLog.find({ targetUser: req.params.id })
      .sort({ createdAt: -1 })
      .limit(100);
    return success(res, 'Action log fetched', logs);
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/dashboard/stats ──────────────────────────────────────────────
const getDashboardStats = async (req, res, next) => {
  try {
    const [totalUsers, totalAdmins, totalProducts, totalOrders, revenueAgg] =
      await Promise.all([
        User.countDocuments({}),
        User.countDocuments({ role: 'admin' }),
        Product.countDocuments({ isActive: true }),
        Order.countDocuments({}),
        Order.aggregate([
          { $match: { status: { $in: ['PAID', 'SHIPPED', 'DELIVERED'] } } },
          { $group: { _id: null, total: { $sum: '$totalPrice' } } },
        ]),
      ]);

    const totalRevenue = revenueAgg[0]?.total || 0;

    return success(res, 'Dashboard stats fetched', {
      totalUsers,
      totalAdmins,
      totalProducts,
      totalOrders,
      totalRevenue,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/coins ──────────────────────────────────────────────
// Full per-transaction coin ledger for a user (every earn/spend/refund/deduct).
// Query: ?page=1&limit=25&type=EARNED&source=PASSIVE_STEPS
const getUserCoinLedger = async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const userOid = new mongoose.Types.ObjectId(req.params.id);

    const page  = Math.max(1, parseInt(req.query.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '25', 10)));
    const skip  = (page - 1) * limit;

    const filter = { user: userOid };
    if (req.query.type)   filter.type = req.query.type;
    if (req.query.source) filter.source = req.query.source;

    const [transactions, total, earnedAgg, spentAgg] = await Promise.all([
      CoinTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CoinTransaction.countDocuments(filter),
      CoinTransaction.aggregate([
        { $match: { user: userOid, type: 'EARNED' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      CoinTransaction.aggregate([
        { $match: { user: userOid, type: { $in: ['SPENT', 'DEDUCTED'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    const formatted = transactions.map((t) => ({
      id: t._id.toString(),
      type: t.type,
      // Signed amount for easy display: credits positive, debits negative.
      signedAmount: (t.type === 'SPENT' || t.type === 'DEDUCTED') ? -t.amount : t.amount,
      amount: t.amount,
      source: t.source,
      description: t.description,
      balanceAfter: t.balanceAfter,
      metadata: t.metadata || {},
      createdAt: t.createdAt,
    }));

    return success(res, 'User coin ledger fetched', {
      transactions: formatted,
      summary: {
        totalEarned: parseFloat((earnedAgg[0]?.total || 0).toFixed(2)),
        totalSpent: parseFloat((spentAgg[0]?.total || 0).toFixed(2)),
      },
      pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /admin/users/:id/steps-tracking ─────────────────────────────────────
// Body: { enabled: boolean, reason?: string }
//
// The per-user step kill switch. Deliberately NOT a ban: the account stays
// fully usable — shop, hydration, meals, challenges, existing coin balance —
// and only step ingestion and step-derived coins stop. Use it when a device is
// a bad data source (broken sensor, third-party app writing inflated records,
// an old build with a counting bug) rather than when a person is misbehaving.
const setStepsTracking = async (req, res, next) => {
  try {
    const { enabled, reason } = req.body;
    if (typeof enabled !== 'boolean') {
      return error(res, 'enabled must be a boolean', 400);
    }

    const user = await User.findById(req.params.id);
    if (!user) return error(res, 'User not found', 404);

    const wasEnabled = user.stepsTracking?.enabled !== false;
    if (wasEnabled === enabled) {
      // Idempotent — repeating the current state is a no-op, not an error, so a
      // retried admin request cannot produce a duplicate audit entry or a second
      // notification to the user.
      return success(res, `Step tracking already ${enabled ? 'enabled' : 'disabled'}`, {
        id: user._id,
        stepsTracking: user.stepsTracking,
        changed: false,
      });
    }

    const now = new Date();
    const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 300) : '';

    if (enabled) {
      user.stepsTracking = {
        enabled: true,
        reason: null,
        disabledAt: null,
        disabledBy: null,
        enabledAt: now,
        enabledBy: req.user._id,
      };
    } else {
      user.stepsTracking = {
        enabled: false,
        reason: cleanReason || DEFAULT_REASON,
        disabledAt: now,
        disabledBy: req.user._id,
        enabledAt: user.stepsTracking?.enabledAt || null,
        enabledBy: user.stepsTracking?.enabledBy || null,
      };
    }

    await user.save();

    await logAdminAction(
      req,
      user._id,
      enabled ? 'STEPS_TRACKING_ON' : 'STEPS_TRACKING_OFF',
      cleanReason,
      {
        // The build the device was last seen on. Recorded on the audit entry
        // because "which version was this user running when we switched them
        // off?" is the whole reason the switch gets used.
        appVersion: user.device?.appVersion || null,
        buildNumber: user.device?.buildNumber || null,
        platform: user.device?.platform || null,
        model: user.device?.model || null,
      },
    );

    // Push so the device reacts now rather than at next app open. The client
    // keys off data.type; the title/body are the user-visible fallback.
    createNotification(user._id, {
      type: 'SECURITY',
      title: enabled ? 'Step tracking resumed' : 'Step tracking paused',
      message: enabled
        ? 'Your steps are being counted again. Open the app to resume tracking.'
        : user.stepsTracking.reason,
      data: {
        type: 'STEPS_TRACKING_CHANGED',
        stepsTrackingEnabled: enabled ? 'true' : 'false',
        reason: user.stepsTracking.reason || '',
        screen: 'StepsScreen',
      },
    }).catch(() => {});

    return success(res, `Step tracking ${enabled ? 'enabled' : 'disabled'}`, {
      id: user._id,
      stepsTracking: user.stepsTracking,
      changed: true,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/stats/app-versions ────────────────────────────────────────────
// Rollout visibility: how many users are on each build, and how many have never
// reported one. Answers "has this user taken the update?" at population scale
// instead of one user at a time.
const getAppVersionStats = async (req, res, next) => {
  try {
    // A user who has not opened the app in months is not evidence about a
    // rollout. Default to the last 30 active days; ?days=0 for all-time.
    const days = Math.max(0, parseInt(req.query.days ?? '30', 10) || 0);
    const activeSince = days > 0 ? new Date(Date.now() - days * 86400000) : null;
    const match = activeSince ? { lastActiveAt: { $gte: activeSince } } : {};

    const [byVersion, stepsOff, total] = await Promise.all([
      User.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              // Null-coalesced to 'unknown' so pre-telemetry builds are a
              // visible bucket rather than silently missing from the totals.
              appVersion: { $ifNull: ['$device.appVersion', 'unknown'] },
              platform: { $ifNull: ['$device.platform', 'unknown'] },
            },
            users: { $sum: 1 },
            lastSeenAt: { $max: '$device.lastSeenAt' },
          },
        },
        { $sort: { users: -1 } },
      ]),
      User.countDocuments({ ...match, 'stepsTracking.enabled': false }),
      User.countDocuments(match),
    ]);

    return success(res, 'App version stats fetched', {
      windowDays: days || null,
      totalUsers: total,
      stepsTrackingDisabled: stepsOff,
      versions: byVersion.map((v) => ({
        appVersion: v._id.appVersion,
        platform: v._id.platform,
        users: v.users,
        share: total ? parseFloat(((v.users / total) * 100).toFixed(2)) : 0,
        lastSeenAt: v.lastSeenAt || null,
      })),
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/device ──────────────────────────────────────────────
// Full device / build trail for one user, including the per-day build stamps on
// their recent health rows. This is the view that answers "the steps this user
// is reporting — which app version produced them?".
const getUserDevice = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select(
      'name email device deviceHistory stepsTracking platform lastActiveAt lastLoginAt',
    );
    if (!user) return error(res, 'User not found', 404);

    const limit = Math.min(60, Math.max(1, parseInt(req.query.days ?? '14', 10) || 14));
    const recentDays = await HealthActivity.find({ user: req.params.id })
      .sort({ date: -1 })
      .limit(limit)
      .select('date steps bonusSteps lastSync syncVersions updatedAt');

    return success(res, 'User device info fetched', {
      user: { id: user._id, name: user.name, email: user.email },
      device: user.device || null,
      deviceHistory: user.deviceHistory || [],
      stepsTracking: user.stepsTracking || { enabled: true },
      lastActiveAt: user.lastActiveAt,
      lastLoginAt: user.lastLoginAt,
      recentDays: recentDays.map((d) => ({
        date: d.date,
        steps: d.steps,
        bonusSteps: d.bonusSteps,
        // null here means the day's data came from a build that predates
        // version headers — the strongest signal that they have not updated.
        lastSync: d.lastSync?.appVersion ? d.lastSync : null,
        syncVersions: d.syncVersions || [],
        updatedAt: d.updatedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/deletions ─────────────────────────────────────────────────────
// Every account with an open deletion request, so a request that the job could
// not act on is visible instead of looking like it was silently skipped.
// Query: ?status=pending|in_progress|blocked  (blocked = has a blockedReason)
const getDeletionRequests = async (req, res, next) => {
  try {
    const { status } = req.query;

    const filter = { 'deletionRequest.status': { $in: ['pending', 'in_progress'] } };
    if (status === 'blocked') {
      filter['deletionRequest.blockedReason'] = { $ne: null };
    } else if (status === 'pending' || status === 'in_progress') {
      filter['deletionRequest.status'] = status;
    }

    const users = await User.find(filter)
      .select('name email role createdAt deletionRequest')
      .sort({ 'deletionRequest.scheduledDeletionDate': 1 })
      .limit(200)
      .lean();

    const now = Date.now();
    return success(res, 'Deletion requests fetched', {
      total: users.length,
      requests: users.map((u) => {
        const d = u.deletionRequest || {};
        const scheduled = d.scheduledDeletionDate ? new Date(d.scheduledDeletionDate) : null;
        return {
          id: u._id,
          name: u.name,
          email: u.email,
          role: u.role,
          status: d.status,
          reason: d.reason || null,
          requestedAt: d.requestedAt || null,
          scheduledDeletionDate: scheduled,
          // Negative means the grace period has already expired — the job
          // should have acted, so a negative value with no blockedReason is
          // the signal that something is wrong.
          daysUntilDeletion: scheduled
            ? Math.ceil((scheduled.getTime() - now) / 86400000)
            : null,
          blockedReason: d.blockedReason || null,
          isOverdue: scheduled ? scheduled.getTime() <= now : false,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /admin/deletions/run ────────────────────────────────────────────────
// Manually trigger the deletion job. Same code path as the scheduled run — used
// to clear a backlog, or to complete a request that was blocked and has since
// been unblocked, without waiting for 4 AM.
const runDeletionJob = async (req, res, next) => {
  try {
    const result = await processAccountDeletions();
    await logAdminAction(req, req.user._id, 'DELETE', 'Manually ran account deletion job', {
      processed: result.processed,
      purged: result.purged,
      blocked: result.blocked,
      failed: result.failed,
    });
    return success(res, 'Deletion job completed', result);
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users/:id/sync-logs ───────────────────────────────────────────
// What this user's device actually sent to /health/sync, next to what the
// server kept. The first thing to look at when someone reports wrong steps —
// before this existed there was no record of the incoming figure at all.
// Query: ?limit=100&date=YYYY-MM-DD&reason=clamped
const getUserSyncLogs = async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit ?? '100', 10) || 100));
    const filter = { user: req.params.id };
    if (req.query.date) filter.date = String(req.query.date);
    if (req.query.reason) filter.logReason = String(req.query.reason);

    const [logs, user] = await Promise.all([
      SyncLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      User.findById(req.params.id).select('syncDebug device').lean(),
    ]);

    const tracing = user?.syncDebug?.enabled === true &&
      (!user.syncDebug.expiresAt || new Date(user.syncDebug.expiresAt) > new Date());

    return success(res, 'Sync logs fetched', {
      // Surfaced so an empty result is not mistaken for "the device sent
      // nothing". By default only anomalous syncs are stored; a quiet log with
      // tracing OFF means nothing unusual happened, which is a different fact.
      tracing,
      tracingExpiresAt: user?.syncDebug?.expiresAt || null,
      currentBuild: user?.device?.appVersion || null,
      total: logs.length,
      logs: logs.map((l) => ({
        at: l.createdAt,
        date: l.date,
        incomingSteps: l.incomingSteps,
        existingSteps: l.existingSteps,
        clampedSteps: l.clampedSteps,
        storedSteps: l.storedSteps,
        // The number that matters: how much the server changed the submission.
        adjustment: l.clampedSteps - l.incomingSteps,
        delta: l.incomingSteps - l.existingSteps,
        flagged: l.flagged,
        severity: l.severity,
        reason: l.reason,
        corrected: l.corrected,
        logReason: l.logReason,
        appVersion: l.appVersion,
        clientSource: l.clientSource,
        timezone: l.timezone,
      })),
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /admin/users/:id/sync-debug ─────────────────────────────────────────
// Body: { enabled: boolean, hours?: number }
// Switch on verbose tracing so EVERY sync from this account is logged, not just
// the anomalous ones. Always time-boxed — see the model comment.
const setSyncDebug = async (req, res, next) => {
  try {
    const { enabled, hours } = req.body;
    if (typeof enabled !== 'boolean') {
      return error(res, 'enabled must be a boolean', 400);
    }

    const user = await User.findById(req.params.id);
    if (!user) return error(res, 'User not found', 404);

    if (enabled) {
      // Default 24h, capped at a week — the TTL on SyncLog is 7 days, so
      // tracing for longer than that only produces rows that expire before
      // anyone reads the start of the trail.
      const windowHours = Math.min(168, Math.max(1, parseInt(hours ?? 24, 10) || 24));
      user.syncDebug = {
        enabled: true,
        enabledAt: new Date(),
        enabledBy: req.user._id,
        expiresAt: new Date(Date.now() + windowHours * 3600 * 1000),
      };
    } else {
      user.syncDebug = { enabled: false, enabledAt: null, enabledBy: null, expiresAt: null };
    }

    await user.save();
    await logAdminAction(
      req,
      user._id,
      'ACCOUNT_EDIT',
      `Sync tracing ${enabled ? 'enabled' : 'disabled'}`,
      { syncDebug: user.syncDebug },
    );

    return success(res, `Sync tracing ${enabled ? 'enabled' : 'disabled'}`, {
      id: user._id,
      syncDebug: user.syncDebug,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getUsers,
  getUserById,
  updateUserRole,
  updateUserAccount,
  adjustUserCoins,
  addBonusSteps,
  resetUserStreak,
  banUser,
  unbanUser,
  getUserSessions,
  revokeUserSession,
  revokeAllUserSessions,
  getUserActionLog,
  deleteUser,
  getUserHealth,
  getUserGamification,
  getUserAchievements,
  getUserOrders,
  getUserCoinLedger,
  getDashboardStats,
  setStepsTracking,
  getAppVersionStats,
  getUserDevice,
  getDeletionRequests,
  runDeletionJob,
  getUserSyncLogs,
  setSyncDebug,
};
