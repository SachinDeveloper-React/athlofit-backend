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

module.exports = { passiveCoinsForSteps, computePassiveCoinDelta };
