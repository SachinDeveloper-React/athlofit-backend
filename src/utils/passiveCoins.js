// src/utils/passiveCoins.js
// ─── Shared passive step-coin math ───────────────────────────────────────────
//
// Passive coins are awarded for every 100 steps at `rate` coins per 100 steps,
// capped per-day at `dailyEarnLimit`. The cap is derived PURELY from steps via a
// watermark — it is INDEPENDENT of goal/hydration coins.
//
// IMPORTANT: Do NOT cap passive coins using `coinsEarnedToday`, because that
// counter also includes daily-step-goal coins and hydration coins. Mixing them
// caused passive coins to stop the moment a user hit their step goal (the goal
// reward alone exceeded the small passive cap).
//
// The watermark (`lastPassiveCoinSteps`) implicitly records how many passive
// coins have already been paid: coins-for(watermark). We award the difference
// between coins-for(currentSteps) and coins-for(watermark), each clamped to the
// daily cap.

/**
 * Coins earned (capped) for a given total step count.
 * @param {number} steps
 * @param {number} rate  coins per 100 steps
 * @param {number} cap   max passive coins per day
 * @returns {number}
 */
function passiveCoinsForSteps(steps, rate, cap) {
  const raw = Math.floor(Math.max(0, steps) / 100) * rate;
  const capped = Math.min(cap, Math.max(0, raw));
  return parseFloat(capped.toFixed(4));
}

/**
 * Compute how many NEW passive coins to award, given the current step total and
 * the watermark (steps at last payout).
 *
 * @param {Object} p
 * @param {number} p.currentSteps      total validated steps today
 * @param {number} p.watermark         lastPassiveCoinSteps (0 on a new day)
 * @param {number} p.rate              coins per 100 steps
 * @param {number} p.dailyEarnLimit    max passive coins per day
 * @returns {{ coins: number, totalForToday: number, alreadyAwarded: number }}
 */
function computePassiveCoinDelta({ currentSteps, watermark, rate, dailyEarnLimit }) {
  const totalForToday = passiveCoinsForSteps(currentSteps, rate, dailyEarnLimit);
  const alreadyAwarded = passiveCoinsForSteps(watermark, rate, dailyEarnLimit);
  const coins = parseFloat(Math.max(0, totalForToday - alreadyAwarded).toFixed(4));
  return { coins, totalForToday, alreadyAwarded };
}

// ─── Is the daily cap actually a cap? ────────────────────────────────────────
//
// `dailyEarnLimit` is the only lever that bounds passive earnings independently
// of the per-step rate, and for a long time it was not bounding anything. The
// two settings are stored separately and were never compared, so nothing in the
// system noticed when they drifted out of range of each other:
//
//   rate 0.095/100 steps x 500 buckets (MAX_DAILY_STEPS) = 47.5 coins/day max,
//   against a dailyEarnLimit of 200 — unreachable by a factor of four.
//
// A cap that cannot be hit is not a safety net, it is a setting that looks like
// one. If the rate were ever raised without touching the limit, the first sign
// would be the payouts themselves.
//
// These helpers make the relationship computable so it can be logged at boot and
// checked whenever an admin edits either value. They deliberately do not CHANGE
// the cap: what the economy should pay is a product decision, and silently
// lowering someone's configured limit would be its own surprise.

const { MAX_DAILY_STEPS } = require('./stepValidation');

/**
 * The most passive coins a single day can possibly pay at `rate`, ignoring the
 * configured cap. Bounded by the anti-cheat's absolute daily step limit, since
 * no larger step count is ever accepted.
 *
 * @param {number} rate coins per 100 steps
 * @param {number} [maxDailySteps]
 * @returns {number}
 */
function maxAchievablePassiveCoins(rate, maxDailySteps = MAX_DAILY_STEPS) {
  return parseFloat(
    (Math.floor(Math.max(0, maxDailySteps) / 100) * Math.max(0, rate)).toFixed(4),
  );
}

/**
 * Describes whether `dailyEarnLimit` can ever bind at the configured rate.
 *
 * @returns {{ rate: number, dailyEarnLimit: number, maxAchievable: number,
 *   capBinds: boolean, summary: string }}
 */
function describePassiveCoinCap(rate, dailyEarnLimit, maxDailySteps = MAX_DAILY_STEPS) {
  const maxAchievable = maxAchievablePassiveCoins(rate, maxDailySteps);
  const capBinds = dailyEarnLimit < maxAchievable;

  const summary = capBinds
    ? `dailyEarnLimit ${dailyEarnLimit} binds — a day can otherwise reach ` +
      `${maxAchievable} coins at ${rate}/100 steps.`
    : `dailyEarnLimit ${dailyEarnLimit} can never bind: ${maxDailySteps.toLocaleString()} ` +
      `steps at ${rate}/100 pays at most ${maxAchievable} coins/day. The per-step ` +
      `rate is the only thing limiting passive earnings.`;

  return { rate, dailyEarnLimit, maxAchievable, capBinds, summary };
}

module.exports = {
  passiveCoinsForSteps,
  computePassiveCoinDelta,
  maxAchievablePassiveCoins,
  describePassiveCoinCap,
};
