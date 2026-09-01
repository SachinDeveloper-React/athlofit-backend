// src/constants/coinDefaults.js
// ─── Coin economy fallbacks, in one place ────────────────────────────────────
//
// These are the values used when the AppConfig document does not carry a
// setting. They were previously written out at each use site, and they drifted:
//
//   * AppConfig.model.js, health.controller.js, the passive-coin cron and the
//     app all defaulted rate_per_100_steps to 0.5.
//   * GET /config/app — the endpoint the app actually reads — defaulted it to
//     0.00095.
//
// So if the field were ever missing from the document, the app would display
// earnings at a rate 526x lower than the server was paying, and neither side
// would log anything. A shared constant makes that class of divergence a
// one-line change instead of a five-file search.
//
// The defaults are FALLBACKS, not the live economy: the AppConfig document is
// authoritative and currently runs a much lower rate. Anything reading these
// should treat a hit as "config missing", which is worth noticing.

/** Coins awarded per 100 steps when AppConfig does not say. */
const DEFAULT_RATE_PER_100_STEPS = 0.5;

/**
 * Largest per-100-step rate an admin may set.
 *
 * The old bound was 1000, which at the anti-cheat's 50,000-step daily ceiling is
 * 500,000 coins in a single day — past anything a typo should be able to reach.
 * This still leaves several orders of magnitude over the rates in use.
 */
const MAX_COIN_RATE_PER_100_STEPS = 100;

/** Max passive coins/day from steps when AppConfig does not say. */
const DEFAULT_DAILY_EARN_LIMIT = 200;

/**
 * Max claimable coins/day across all sources when AppConfig does not say.
 *
 * Raised from 250 when the cap was first actually enforced on challenge rewards.
 * Until then challenge coins bypassed it entirely — neither clamped nor counted
 * into `coinsEarnedToday` — so the configured number had never had to agree with
 * what the content offers, and it did not: the seeded daily challenges alone are
 * worth 675 against a cap of 250. Enforcing 250 unchanged would have paid a user
 * for roughly their first challenge and nothing after, so the number had to move
 * with the rule.
 *
 * This is ONLY the fallback for a config document that is missing the field. It
 * is deliberately not presented as the right answer for any deployment: the real
 * ceiling depends on the live passive limit and on whichever challenges are
 * actually active, which no constant can know. `GET /config/coin-economy` adds
 * those up from live data and says whether the configured cap binds — that is
 * what an admin should size against, and `AppConfig.coin.maxDailyRewards` is
 * what they should change. Editing this constant changes nothing for anyone who
 * already has the field set.
 */
const DEFAULT_MAX_DAILY_REWARDS = 950;

/** Max coins/day for users who have not verified their email. */
const DEFAULT_UNVERIFIED_DAILY_CAP = 50;

module.exports = {
  DEFAULT_RATE_PER_100_STEPS,
  MAX_COIN_RATE_PER_100_STEPS,
  DEFAULT_DAILY_EARN_LIMIT,
  DEFAULT_MAX_DAILY_REWARDS,
  DEFAULT_UNVERIFIED_DAILY_CAP,
};
