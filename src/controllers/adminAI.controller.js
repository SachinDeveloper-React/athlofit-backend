// src/controllers/adminAI.controller.js
// ─── AI-powered analysis for user performance + ecommerce suggestions ────────

const mongoose = require('mongoose');
const User = require('../models/User.model');
const Gamification = require('../models/Gamification.model');
const HealthActivity = require('../models/HealthActivity.model');
const Order = require('../models/Order.model');
const Product = require('../models/Product.model');
const CoinTransaction = require('../models/CoinTransaction.model');
const { success, error } = require('../utils/response');
const { isAIConfigured, generate } = require('../utils/aiClient');

// ─── Gather a compact stats snapshot for a user ──────────────────────────────
async function gatherUserStats(userId) {
  const oid = new mongoose.Types.ObjectId(userId);
  const [user, gam, healthAgg, recent, ordersCount, earnedAgg] = await Promise.all([
    User.findById(userId).select('name email dailyStepGoal createdAt'),
    Gamification.findOne({ user: oid }),
    HealthActivity.aggregate([
      { $match: { user: oid } },
      {
        $group: {
          _id: null,
          totalSteps: { $sum: '$steps' },
          avgSteps: { $avg: '$steps' },
          maxSteps: { $max: '$steps' },
          totalHydration: { $sum: '$hydration' },
          daysTracked: { $sum: 1 },
          goalsMet: { $sum: { $cond: ['$goalMet', 1, 0] } },
        },
      },
    ]),
    HealthActivity.find({ user: oid }).sort({ date: -1 }).limit(14).select('date steps goalMet'),
    Order.countDocuments({ user: oid, status: { $ne: 'CANCELLED' } }),
    CoinTransaction.aggregate([
      { $match: { user: oid, type: 'EARNED' } },
      { $group: { _id: '$source', total: { $sum: '$amount' } } },
    ]),
  ]);

  const h = healthAgg[0] || {};
  const coinsBySource = {};
  for (const e of earnedAgg) coinsBySource[e._id] = Math.round(e.total);

  return {
    name: user?.name,
    dailyStepGoal: user?.dailyStepGoal || 10000,
    memberSince: user?.createdAt,
    coinsBalance: gam?.coinsBalance || 0,
    currentStreak: gam?.streakDays || 0,
    bestStreak: gam?.bestStreakDays || 0,
    badgesUnlocked: (gam?.badgeList || []).filter((b) => b.unlocked).length,
    achievementsClaimed: (gam?.claimedAchievements || []).length,
    totalSteps: Math.round(h.totalSteps || 0),
    avgStepsPerDay: Math.round(h.avgSteps || 0),
    maxSteps: h.maxSteps || 0,
    daysTracked: h.daysTracked || 0,
    goalsMet: h.goalsMet || 0,
    goalHitRate: h.daysTracked ? Math.round((h.goalsMet / h.daysTracked) * 100) : 0,
    totalHydration: Math.round(h.totalHydration || 0),
    ordersCount,
    coinsBySource,
    last14Days: recent.reverse().map((r) => ({ date: r.date, steps: r.steps, goalMet: r.goalMet })),
  };
}

// ─── Rule-based fallback for performance insights ────────────────────────────
function performanceFallback(s) {
  const insights = [];
  const suggestions = [];

  if (s.goalHitRate >= 80) insights.push(`Excellent consistency — hits the daily step goal ${s.goalHitRate}% of tracked days.`);
  else if (s.goalHitRate >= 50) insights.push(`Moderate consistency — hits the goal ${s.goalHitRate}% of days; room to improve.`);
  else insights.push(`Low goal completion (${s.goalHitRate}%). Engagement may be at risk.`);

  if (s.currentStreak >= 7) insights.push(`Strong active streak of ${s.currentStreak} days.`);
  else if (s.currentStreak === 0) insights.push('Streak is broken — a re-engagement nudge could help.');

  insights.push(`Averages ${s.avgStepsPerDay.toLocaleString()} steps/day against a ${s.dailyStepGoal.toLocaleString()} goal.`);

  if (s.avgStepsPerDay < s.dailyStepGoal) suggestions.push('Send a motivational push to close the gap to their daily goal.');
  if (s.currentStreak === 0) suggestions.push('Offer a small streak-restart bonus to rebuild momentum.');
  if (s.ordersCount === 0 && s.coinsBalance > 500) suggestions.push(`Has ${s.coinsBalance} unspent coins and no orders — promote the shop.`);
  if (s.goalHitRate >= 80) suggestions.push('A high-performer — good candidate for premium challenges or referrals.');

  return {
    summary: `${s.name || 'This user'} has logged ${s.totalSteps.toLocaleString()} steps over ${s.daysTracked} days, with a ${s.goalHitRate}% goal-hit rate and a ${s.currentStreak}-day current streak (best: ${s.bestStreak}).`,
    insights,
    suggestions,
  };
}

// ─── POST /admin/users/:id/ai-analysis ───────────────────────────────────────
const analyzeUser = async (req, res, next) => {
  try {
    const userId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(userId)) return error(res, 'Invalid user id', 400);

    const stats = await gatherUserStats(userId);

    if (!isAIConfigured()) {
      return success(res, 'AI analysis (rule-based fallback)', {
        ...performanceFallback(stats),
        aiPowered: false,
        stats,
      });
    }

    const system =
      'You are a fitness analytics assistant for an admin dashboard. Analyze the user\'s ' +
      'health and gamification data. Respond ONLY with strict JSON: ' +
      '{ "summary": string, "insights": string[], "suggestions": string[] }. ' +
      'Insights describe performance, streaks, and achievements. Suggestions are concrete ' +
      'admin actions (engagement, retention, rewards). Keep each item under 25 words.';

    const userPrompt = `User performance data:\n${JSON.stringify(stats, null, 2)}`;

    let parsed;
    try {
      const raw = await generate(system, userPrompt);
      const jsonStr = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch (aiErr) {
      // Fall back gracefully if the model errors or returns non-JSON.
      return success(res, 'AI analysis (fallback after error)', {
        ...performanceFallback(stats),
        aiPowered: false,
        stats,
      });
    }

    return success(res, 'AI analysis generated', {
      summary: parsed.summary || '',
      insights: parsed.insights || [],
      suggestions: parsed.suggestions || [],
      aiPowered: true,
      stats,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Rule-based fallback for ecommerce suggestions ───────────────────────────
function ecommerceFallback(stats, products) {
  // Rank active products by featured + rating; pick top few.
  const ranked = [...products]
    .sort((a, b) => (b.isFeatured - a.isFeatured) || (b.rating - a.rating))
    .slice(0, 5)
    .map((p) => ({
      productId: p._id,
      name: p.name,
      reason:
        stats.coinsBalance >= (p.discountedPrice ?? p.price) * 10
          ? 'Affordable with their current coin balance.'
          : 'Popular, well-rated product to drive engagement.',
    }));

  const suggestions = [];
  if (stats.coinsBalance > 1000) suggestions.push(`User has ${stats.coinsBalance} coins — surface higher-value products.`);
  if (stats.ordersCount === 0) suggestions.push('First-time buyer — a welcome discount could convert them.');
  if (stats.goalHitRate >= 70) suggestions.push('Active user — recommend performance supplements or gear.');

  return {
    summary: `Based on ${stats.coinsBalance} coins and ${stats.ordersCount} past orders, here are recommended products.`,
    recommendations: ranked,
    suggestions,
  };
}

// ─── POST /admin/users/:id/ai-recommendations ────────────────────────────────
// AI ecommerce product suggestions for a specific user.
const recommendForUser = async (req, res, next) => {
  try {
    const userId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(userId)) return error(res, 'Invalid user id', 400);

    const [stats, products, pastOrders] = await Promise.all([
      gatherUserStats(userId),
      Product.find({ isActive: true })
        .populate('category', 'name')
        .select('name price discountedPrice rating isFeatured tags category')
        .limit(40),
      Order.find({ user: userId }).select('items.name').limit(20),
    ]);

    if (!isAIConfigured()) {
      return success(res, 'AI recommendations (rule-based fallback)', {
        ...ecommerceFallback(stats, products),
        aiPowered: false,
      });
    }

    const catalog = products.map((p) => ({
      id: p._id.toString(),
      name: p.name,
      price: p.discountedPrice ?? p.price,
      rating: p.rating,
      category: p.category?.name,
      tags: p.tags,
    }));
    const purchased = pastOrders.flatMap((o) => (o.items || []).map((i) => i.name));

    const system =
      'You are an ecommerce recommendation engine for a fitness app. Given a user\'s fitness ' +
      'profile, coin balance, purchase history, and the product catalog, recommend the best ' +
      'products. Respond ONLY with strict JSON: { "summary": string, "recommendations": ' +
      '[{ "productId": string, "name": string, "reason": string }], "suggestions": string[] }. ' +
      'Only use productId values from the catalog. Max 5 recommendations.';

    const userPrompt = `User profile:\n${JSON.stringify(stats, null, 2)}\n\nPast purchases: ${JSON.stringify(purchased)}\n\nProduct catalog:\n${JSON.stringify(catalog, null, 2)}`;

    let parsed;
    try {
      const raw = await generate(system, userPrompt);
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return success(res, 'AI recommendations (fallback after error)', {
        ...ecommerceFallback(stats, products),
        aiPowered: false,
      });
    }

    return success(res, 'AI recommendations generated', {
      summary: parsed.summary || '',
      recommendations: parsed.recommendations || [],
      suggestions: parsed.suggestions || [],
      aiPowered: true,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { analyzeUser, recommendForUser };
