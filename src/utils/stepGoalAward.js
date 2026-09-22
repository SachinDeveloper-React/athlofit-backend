// src/utils/stepGoalAward.js
// ─── How much of the daily step-goal bonus is actually payable? ──────────────
//
// Two callers pay this bonus — the same-day award in syncHealthData and the
// retroactive award for a past date — and both used to compute the amount and
// then claim the day REGARDLESS of whether the amount was zero.
//
// That is destructive, because claiming the day is not just bookkeeping:
//
//   * `stepGoalCoinDate` is the shared idempotency key. POST /gamification/
//     rewards/claim refuses with "Reward already claimed" once it is set for
//     today (gamification.controller.js), so a zero-value claim permanently
//     denies the user that day's bonus by hand as well.
//   * `retroGoalCoinAwarded` does the same for the past-date path, so the day
//     cannot be repaired by a later sync either.
//   * A claimHistory entry for 0 coins is pushed into a 50-entry ring buffer,
//     evicting a real one.
//
// The amount is zero in two situations that both matter:
//
//   * The bonus is switched off (`rewards.stepGoalCoins` set to 0), which is the
//     live configuration. Every goal-meeting user was burning a claim, writing an
//     empty history row and — because the notification sat outside the amount
//     check — being told "You hit your 10,000 step goal and earned 0 coins!" once
//     a day. If the bonus were ever switched back on, every day already consumed
//     would stay unpayable.
//   * The daily cap is already exhausted, where burning the claim turns a
//     temporary "no allowance left" into a permanent "already claimed".
//
// Nothing here decides whether the GOAL was met — that is resolveGoalMet's job,
// and the streak, the stored goalMet flag and challenge credit all continue to
// follow it. This only decides whether there are coins to hand over.
//
// Lives in utils rather than the controller so it is testable: requiring
// health.controller.js pulls in the push-notification stack and initialises
// firebase-admin, which needs live service-account credentials.

/**
 * @param {object} params
 * @param {number} params.stepGoalCoins Configured bonus for meeting the goal.
 * @param {number} [params.effectiveCap] Daily coin ceiling for this user. Omit
 *   to skip the cap entirely, which is what the retroactive path does.
 * @param {number} [params.coinsEarnedToday] Coins already earned today, counted
 *   against `effectiveCap`.
 * @returns {{ coins: number, shouldClaim: boolean }} `shouldClaim` is false
 *   whenever `coins` is zero — claim the day only when something is paid for it.
 */
function resolveStepGoalAward({
  stepGoalCoins,
  effectiveCap = null,
  coinsEarnedToday = 0,
}) {
  const configured = Math.max(0, Number(stepGoalCoins) || 0);

  const payable =
    effectiveCap === null
      ? configured
      : Math.min(configured, Math.max(0, effectiveCap - (coinsEarnedToday || 0)));

  const coins = Math.round(payable);
  return { coins, shouldClaim: coins > 0 };
}

// ─── One bonus, two settings ────────────────────────────────────────────────
//
// The daily step-goal bonus was configurable in two places that nothing kept
// in step:
//
//   rewards.stepGoalCoins                                 — the original field
//   coin_config.rewards.daily_step_goal_reached.coin_value — added later, with
//                                                            an `enabled` switch
//
// and the four paths that pay it read them in different orders. The same-day
// award on sync and the retroactive award read `rewards.stepGoalCoins`; the
// manual claim, the "steps_daily_card" claim and the end-of-day cron read
// `coin_value` first. So with the admin's field set to 0 and the other still
// at 13.25, a sync paid nothing, the Earn Coins card SHOWED 0 — it reads the
// admin's field too — and tapping Claim paid 13. One account did exactly that
// every evening for a week.
//
// This is the one place the bonus is read from now. `rewards.stepGoalCoins`
// is the amount — it is the field the admin panel edits and the one every
// document already has — and `daily_step_goal_reached.enabled` remains a
// switch on top of it. `coin_value` is kept as a mirror for the config API
// and the app; the config update path writes both fields whenever either is
// edited, so they cannot drift again.

/** Bonus for a missing field, matching the AppConfig schema default. */
const DEFAULT_STEP_GOAL_COINS = 50;

/**
 * The daily step-goal bonus as configured.
 *
 * @param {object|null} cfg The AppConfig document (or its lean copy).
 * @returns {{ enabled: boolean, coins: number }} `coins` is 0 whenever the
 *   bonus is disabled, so callers can pay `coins` without a second check.
 */
function configuredStepGoalBonus(cfg) {
  const enabled =
    cfg?.coin_config?.rewards?.daily_step_goal_reached?.enabled ?? true;
  const raw = Number(cfg?.rewards?.stepGoalCoins);
  const amount = Number.isFinite(raw) ? Math.max(0, raw) : DEFAULT_STEP_GOAL_COINS;
  return { enabled: Boolean(enabled), coins: enabled ? amount : 0 };
}

module.exports = {
  resolveStepGoalAward,
  configuredStepGoalBonus,
  DEFAULT_STEP_GOAL_COINS,
};
