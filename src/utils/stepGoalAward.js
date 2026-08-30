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

module.exports = { resolveStepGoalAward };
