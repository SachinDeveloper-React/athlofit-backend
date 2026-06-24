// src/controllers/adminAnalytics.controller.js
// ─── Time-bucketed step & coin analytics for a single user (admin) ───────────

const mongoose = require('mongoose');
const HealthActivity = require('../models/HealthActivity.model');
const CoinTransaction = require('../models/CoinTransaction.model');
const Order = require('../models/Order.model');
const { success, error } = require('../utils/response');

// Parse a "YYYY-MM-DD" string into a Date (UTC midnight).
function parseDate(str) {
  const d = new Date(`${str}T00:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d;
}

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

// Build the bucket key for a given date string + granularity.
function bucketKey(dateStr, granularity) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (granularity === 'monthly') {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (granularity === 'weekly') {
    // ISO week start (Monday)
    const tmp = new Date(d);
    const day = (tmp.getUTCDay() + 6) % 7; // Mon=0
    tmp.setUTCDate(tmp.getUTCDate() - day);
    return toISODate(tmp);
  }
  return dateStr; // daily
}

// ─── GET /admin/users/:id/analytics ──────────────────────────────────────────
// Query: ?period=daily|weekly|monthly|custom&from=YYYY-MM-DD&to=YYYY-MM-DD
// Default window: last 30 days, daily granularity.
const getUserAnalytics = async (req, res, next) => {
  try {
    const userId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return error(res, 'Invalid user id', 400);
    }

    const { period = 'daily', from, to } = req.query;

    // Resolve the date window.
    const today = new Date();
    let startDate;
    let endDate = to ? parseDate(to) : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

    if (from) {
      startDate = parseDate(from);
    } else {
      // Default windows per period
      const daysBack = period === 'monthly' ? 365 : period === 'weekly' ? 84 : 30;
      startDate = new Date(endDate);
      startDate.setUTCDate(startDate.getUTCDate() - daysBack + 1);
    }

    if (!startDate || !endDate || startDate > endDate) {
      return error(res, 'Invalid date range', 400);
    }

    // Granularity defaults to the period (custom → daily unless very wide)
    let granularity = period === 'custom' ? 'daily' : period;
    if (period === 'custom') {
      const spanDays = Math.round((endDate - startDate) / 86400000);
      if (spanDays > 180) granularity = 'monthly';
      else if (spanDays > 45) granularity = 'weekly';
      else granularity = 'daily';
    }

    const startStr = toISODate(startDate);
    const endStr = toISODate(endDate);
    const userOid = new mongoose.Types.ObjectId(userId);

    // ── Steps from HealthActivity (date stored as "YYYY-MM-DD" string) ────────
    const activities = await HealthActivity.find({
      user: userOid,
      date: { $gte: startStr, $lte: endStr },
    }).select('date steps calories hydration activeMinutes distance goalMet').sort({ date: 1 });

    // ── Coins from CoinTransaction (real source of truth) ─────────────────────
    const coinTxns = await CoinTransaction.find({
      user: userOid,
      createdAt: { $gte: startDate, $lte: new Date(endDate.getTime() + 86399999) },
    }).select('type amount source createdAt').sort({ createdAt: 1 });

    // ── Bucket the data ───────────────────────────────────────────────────────
    const buckets = new Map();
    const ensureBucket = (key) => {
      if (!buckets.has(key)) {
        buckets.set(key, {
          period: key,
          steps: 0, calories: 0, hydration: 0, activeMinutes: 0, distance: 0,
          goalsMet: 0, daysTracked: 0,
          coinsEarned: 0, coinsSpent: 0,
        });
      }
      return buckets.get(key);
    };

    for (const a of activities) {
      const b = ensureBucket(bucketKey(a.date, granularity));
      b.steps += a.steps || 0;
      b.calories += a.calories || 0;
      b.hydration += a.hydration || 0;
      b.activeMinutes += a.activeMinutes || 0;
      b.distance += a.distance || 0;
      b.daysTracked += 1;
      if (a.goalMet) b.goalsMet += 1;
    }

    // Per-source coin breakdown across the whole window
    const coinBySource = {};
    for (const t of coinTxns) {
      const key = bucketKey(toISODate(t.createdAt), granularity);
      const b = ensureBucket(key);
      if (t.type === 'SPENT') b.coinsSpent += t.amount;
      else b.coinsEarned += t.amount; // EARNED + REFUND

      if (t.type !== 'SPENT') {
        coinBySource[t.source] = (coinBySource[t.source] || 0) + t.amount;
      }
    }

    // Sorted series
    const series = Array.from(buckets.values()).sort((a, b) =>
      a.period < b.period ? -1 : a.period > b.period ? 1 : 0,
    ).map((b) => ({
      ...b,
      calories: Math.round(b.calories),
      distance: Math.round(b.distance * 100) / 100,
      coinsEarned: Math.round(b.coinsEarned * 100) / 100,
      coinsSpent: Math.round(b.coinsSpent * 100) / 100,
    }));

    // Totals
    const totals = series.reduce(
      (acc, b) => {
        acc.steps += b.steps;
        acc.calories += b.calories;
        acc.hydration += b.hydration;
        acc.activeMinutes += b.activeMinutes;
        acc.distance += b.distance;
        acc.goalsMet += b.goalsMet;
        acc.daysTracked += b.daysTracked;
        acc.coinsEarned += b.coinsEarned;
        acc.coinsSpent += b.coinsSpent;
        return acc;
      },
      { steps: 0, calories: 0, hydration: 0, activeMinutes: 0, distance: 0, goalsMet: 0, daysTracked: 0, coinsEarned: 0, coinsSpent: 0 },
    );

    totals.distance = Math.round(totals.distance * 100) / 100;
    totals.coinsEarned = Math.round(totals.coinsEarned * 100) / 100;
    totals.coinsSpent = Math.round(totals.coinsSpent * 100) / 100;
    totals.netCoins = Math.round((totals.coinsEarned - totals.coinsSpent) * 100) / 100;
    totals.avgStepsPerDay = totals.daysTracked ? Math.round(totals.steps / totals.daysTracked) : 0;

    return success(res, 'User analytics fetched', {
      range: { from: startStr, to: endStr, granularity },
      series,
      totals,
      coinBySource,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getUserAnalytics };
