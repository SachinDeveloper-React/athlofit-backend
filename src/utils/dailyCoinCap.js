// src/utils/dailyCoinCap.js
//
// The daily coin ceiling, and how much of it a user has left.
//
// ── Why this is shared ──────────────────────────────────────────────────────
//
// `getEffectiveDailyCap` existed as two byte-identical private copies, in
// health.controller.js and gamification.controller.js. A third caller needed it,
// and copying it again is precisely how the app's sync throttle drifted from the
// test that claimed to pin it — two definitions of one rule, and nothing to
// notice when they stop agreeing.
//
// ── What the cap is for ─────────────────────────────────────────────────────
//
// It bounds what a user can FARM in a day. That word does real work: rewards
// which are not farmable are deliberately exempt (a streak badge is once per
// lifetime and gated on a milestone the server recorded, so capping it only
// destroyed coins the user had genuinely earned — see the note in
// gamification.controller.js). Everything repeatable is in scope.
//
// Two separate ceilings exist and are not the same thing:
//
//   * `coin.dailyEarnLimit`   — passive step coins ONLY, applied inside
//                               computePassiveCoinDelta. Step-derived and
//                               independent, so hitting the step goal cannot
//                               stop passive earning.
//   * `coin.maxDailyRewards`  — the overall ceiling across reward sources,
//                               spent against `coinsEarnedToday`. This file.

// Fallbacks come from the shared constants module rather than being restated
// here. Restating them is the same mistake one level down: this file exists to
// stop a rule having two definitions, so it must not give its defaults two.
const {
  DEFAULT_MAX_DAILY_REWARDS,
  DEFAULT_UNVERIFIED_DAILY_CAP,
} = require('../constants/coinDefaults');

/**
 * The daily ceiling that applies to this user.
 *
 * Unverified accounts get the lower of the two limits, never the higher: the
 * unverified cap is a fraud control, so a config where `unverifiedDailyCap`
 * exceeds the normal cap must not accidentally raise it.
 *
 * @param {object} user - needs `emailVerified`.
 * @param {number} configMax - `coin.maxDailyRewards`.
 * @param {number} [unverifiedCap] - `coin.unverifiedDailyCap`.
 * @returns {number}
 */
function getEffectiveDailyCap(user, configMax, unverifiedCap) {
  const max = Number.isFinite(configMax) ? configMax : DEFAULT_MAX_DAILY_REWARDS;
  if (user?.emailVerified) return max;
  const cap = Number.isFinite(unverifiedCap)
    ? unverifiedCap
    : DEFAULT_UNVERIFIED_DAILY_CAP;
  return Math.min(cap, max);
}

/**
 * How many coins of `requested` may actually be paid right now.
 *
 * Returns the clamped amount rather than a boolean, so callers credit exactly
 * what they are allowed to and can tell whether the award was partial. That
 * distinction matters: a caller which marks a reward permanently claimed must
 * not do so when the ceiling paid out less than the reward was worth, or the
 * remainder is destroyed rather than deferred.
 *
 * @param {object} p
 * @param {number} p.requested - the reward's full value.
 * @param {number} p.coinsEarnedToday - what the day has already paid.
 * @param {number} p.cap - from getEffectiveDailyCap.
 * @returns {{ payable: number, remaining: number, capped: boolean }}
 */
function allowanceFor({ requested, coinsEarnedToday, cap }) {
  const want = Math.max(0, Number(requested) || 0);
  const spent = Math.max(0, Number(coinsEarnedToday) || 0);
  const remaining = Math.max(0, cap - spent);
  const payable = Math.min(want, remaining);

  return {
    payable: parseFloat(payable.toFixed(4)),
    remaining: parseFloat(remaining.toFixed(4)),
    capped: payable < want,
  };
}


/**
 * What a single day could actually pay out, and whether the cap can bind on it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `maxDailyRewards` is one number, edited by hand, that has to stay in a sane
 * relationship with several others nobody edits at the same time: the passive
 * step limit, the step-goal and hydration rewards, and every active daily
 * challenge's `coinReward`. Nothing compared them, so they drifted badly — the
 * challenge rewards alone were worth several times the whole cap, and that went
 * unnoticed only because challenge awards were not checking the cap at all.
 *
 * This is the same treatment describePassiveCoinCap gives the passive rate, and
 * for the same reason: whoever edits one of these values is the one person
 * positioned to notice, so they get told at the moment they edit rather than
 * from a payout months later.
 *
 * Deliberately computed from LIVE inputs rather than from constants. The seeded
 * challenge set is not what any particular deployment is running, and a number
 * baked in here would be wrong for everyone the moment an admin adds a
 * challenge — which is precisely the drift this is meant to catch.
 *
 * Weekly challenges are excluded from `perfectDay` and reported separately: each
 * completes at most once a week, so a cap sized to fit all of them landing on
 * one day would never bind on a normal day. They are still worth showing,
 * because a week's worth CAN land together.
 *
 * @param {object} p — all live values, in coins.
 * @returns {{ perfectDay: number, capBinds: boolean, shortfall: number,
 *   breakdown: object, weeklyChallengeCoins: number, summary: string }}
 */
function describeDailyRewardCap({
  maxDailyRewards,
  dailyEarnLimit = 0,
  stepGoalCoins = 0,
  hydrationGoalCoins = 0,
  dailyChallengeCoins = 0,
  weeklyChallengeCoins = 0,
}) {
  const n = (v) => Math.max(0, Number(v) || 0);

  const breakdown = {
    passiveSteps: n(dailyEarnLimit),
    stepGoal: n(stepGoalCoins),
    hydrationGoal: n(hydrationGoalCoins),
    dailyChallenges: n(dailyChallengeCoins),
  };

  const perfectDay = parseFloat(
    Object.values(breakdown)
      .reduce((a, b) => a + b, 0)
      .toFixed(4),
  );

  const cap = n(maxDailyRewards);
  const capBinds = cap < perfectDay;
  const shortfall = parseFloat(Math.max(0, perfectDay - cap).toFixed(4));

  const summary = capBinds
    ? `maxDailyRewards ${cap} binds: a user completing everything available ` +
      `would earn ${perfectDay}, so ${shortfall} coins/day of published rewards ` +
      `cannot be paid.`
    : `maxDailyRewards ${cap} can never bind: everything available in one day ` +
      `pays at most ${perfectDay}. The cap is not limiting anything.`;

  return {
    maxDailyRewards: cap,
    perfectDay,
    capBinds,
    shortfall,
    breakdown,
    weeklyChallengeCoins: n(weeklyChallengeCoins),
    summary,
  };
}

/**
 * Atomically credit up to `requested` coins against the shared daily cap.
 *
 * ── Why `allowanceFor` alone is not enough ──────────────────────────────────
 *
 * Every award path already calls `allowanceFor` — but each one calls it
 * against a `coinsEarnedToday` it read a moment earlier, then writes with a
 * plain `$inc` guarded only by a PER-REWARD idempotency flag (e.g.
 * `stepGoalCoinDate !== today`). That flag stops the SAME reward being paid
 * twice, but it does nothing to stop the AGGREGATE cap being exceeded: a step
 * sync and a challenge completion can both read `coinsEarnedToday = 200`
 * against a cap of 250, each independently decide it has 50 coins of room,
 * and each `$inc` a different reward — both succeed, and the true total lands
 * at 300. This is that race, closed: the write is conditioned on
 * `coinsEarnedToday` still equalling the exact value the allowance was
 * computed from (a compare-and-swap), so a concurrent credit from ANY source
 * invalidates the write instead of silently stacking with it, and the caller
 * retries against a fresh read rather than losing the coins.
 *
 * @param {import('mongoose').Model} Model - the Gamification model.
 * @param {object} p
 * @param {string|import('mongoose').Types.ObjectId} p.userId
 * @param {number} p.requested - the reward's full value before capping.
 * @param {number} p.cap - from getEffectiveDailyCap.
 * @param {object} [p.matchExtra] - extra filter clauses ANDed into every
 *   attempt's read AND write (e.g. `{ stepGoalCoinDate: { $ne: today } }`).
 *   A non-match means the reward was already claimed (or excluded) — the
 *   whole call returns null.
 * @param {object} [p.setExtra] - `$set` fields applied whenever a write
 *   happens (e.g. stamping the idempotency date). Applied even when the cap
 *   reduces `actualCoins` to 0, so a capped-out daily reward still counts as
 *   claimed for today rather than being retried. Pass `{}` (default) for
 *   rewards — like challenges — that should stay unclaimed and retryable
 *   whenever the cap fully blocks them.
 * @param {{rewardId: string, source: string}} [p.historyEntry] - if given, a
 *   `claimHistory` entry is pushed (capped to the last 50) whenever
 *   `actualCoins > 0`, with `amount` filled in automatically.
 * @param {number} [p.maxAttempts=5]
 * @returns {Promise<{gam: object, actualCoins: number, capped: boolean} | null>}
 *   null means `matchExtra` never matched (already claimed by this or a
 *   concurrent request) — including every retry attempt losing the CAS race
 *   for `maxAttempts` tries in a row, which only a sustained burst of
 *   concurrent awards for this same user could cause.
 */
async function awardCappedCoins(Model, {
  userId,
  requested,
  cap,
  matchExtra = {},
  setExtra = {},
  historyEntry,
  maxAttempts = 5,
}) {
  const hasSetExtra = Object.keys(setExtra).length > 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const gam = await Model.findOne({ user: userId, ...matchExtra });
    if (!gam) return null;

    const coinsEarnedToday = gam.coinsEarnedToday || 0;
    const { payable, capped } = allowanceFor({ requested, coinsEarnedToday, cap });
    const actualCoins = Math.round(payable);

    if (actualCoins <= 0 && !hasSetExtra) {
      // Nothing to pay and nothing to stamp — leave the reward claimable
      // later (e.g. a challenge, once today's allowance frees up).
      return { gam, actualCoins: 0, capped };
    }

    const update = {};
    if (hasSetExtra) update.$set = setExtra;
    if (actualCoins > 0) {
      update.$inc = { coinsBalance: actualCoins, coinsEarnedToday: actualCoins };
      if (historyEntry) {
        update.$push = {
          claimHistory: {
            $each: [{ ...historyEntry, amount: actualCoins, createdAt: new Date() }],
            $slice: -50,
          },
        };
      }
    }

    const updated = await Model.findOneAndUpdate(
      // Pinning coinsEarnedToday to the exact value just read is the CAS: if
      // anything else credited this user between our read and this write,
      // the match fails and we loop to recompute against the new total.
      { user: userId, coinsEarnedToday: gam.coinsEarnedToday, ...matchExtra },
      update,
      { new: true },
    );
    if (updated) return { gam: updated, actualCoins, capped };
  }
  return null;
}

module.exports = {
  getEffectiveDailyCap,
  allowanceFor,
  awardCappedCoins,
  describeDailyRewardCap,
};
