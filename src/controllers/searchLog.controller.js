// src/controllers/searchLog.controller.js
// ─── Search query & click logging for the Food Catalog ───────────────────────
//
// POST /nutrition/search/log-query   → record a search query event
// POST /nutrition/search/log-click   → record a result-click event
// GET  /nutrition/search/history     → fetch the current user's recent queries

const SearchLog  = require('../models/SearchLog.model');
const FoodSynonym = require('../models/FoodSynonym.model');
const { success, error } = require('../utils/response');

// ─── Helper: resolve a raw query to its canonical form via synonym map ────────

async function resolveQuery(raw) {
  const term = raw.trim().toLowerCase();
  const synonym = await FoodSynonym.findOne({ aliases: term });
  return synonym ? synonym.canonical : term;
}

// ─── POST /nutrition/search/log-query ─────────────────────────────────────────
// Body: { query, meta? }
//   query  — the raw text the user typed
//   meta   — optional object with any extra fields (screen, sessionId, …)

const logSearchQuery = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { query, meta = {} } = req.body;

    if (!query || typeof query !== 'string' || !query.trim()) {
      return error(res, 'query is required', 400);
    }

    const resolvedQuery = await resolveQuery(query);

    await SearchLog.create({
      user: userId,
      type: 'query',
      query: query.trim(),
      resolvedQuery,
      meta,
    });

    return success(res, 'Search query logged', { resolvedQuery });
  } catch (err) {
    next(err);
  }
};

// ─── POST /nutrition/search/log-click ─────────────────────────────────────────
// Body: { query, clickedFoodId, clickedFoodName, resultPosition?, meta? }

const logSearchClick = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const {
      query,
      clickedFoodId,
      clickedFoodName,
      resultPosition = null,
      meta = {},
    } = req.body;

    if (!query || typeof query !== 'string' || !query.trim()) {
      return error(res, 'query is required', 400);
    }
    if (!clickedFoodId) {
      return error(res, 'clickedFoodId is required', 400);
    }
    if (!clickedFoodName) {
      return error(res, 'clickedFoodName is required', 400);
    }

    const resolvedQuery = await resolveQuery(query);

    await SearchLog.create({
      user: userId,
      type: 'click',
      query: query.trim(),
      resolvedQuery,
      clickedFoodId,
      clickedFoodName,
      resultPosition,
      meta,
    });

    return success(res, 'Search click logged');
  } catch (err) {
    next(err);
  }
};

// ─── GET /nutrition/search/history ────────────────────────────────────────────
// Returns the last 20 unique query strings for the current user.
// Query: ?limit=20

const getSearchHistory = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit ?? '20', 10)));

    // Distinct recent queries (type='query' only, most recent first)
    const logs = await SearchLog.find({ user: userId, type: 'query' })
      .sort({ createdAt: -1 })
      .limit(limit * 3)   // over-fetch to deduplicate
      .select('query resolvedQuery createdAt meta');

    // Deduplicate by raw query, keep most recent occurrence
    const seen = new Set();
    const unique = [];
    for (const log of logs) {
      if (!seen.has(log.query)) {
        seen.add(log.query);
        unique.push(log);
        if (unique.length >= limit) break;
      }
    }

    return success(res, 'Search history fetched', { history: unique });
  } catch (err) {
    next(err);
  }
};

module.exports = { logSearchQuery, logSearchClick, getSearchHistory };
