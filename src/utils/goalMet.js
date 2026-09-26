// src/utils/goalMet.js
// ─── Was the daily step goal met? ────────────────────────────────────────────
//
// The server decides, because it alone holds the authoritative numbers:
// `totalSteps` is walked + admin-credited bonus, and `dailyGoal` is the user's
// goal as of now. The client's `goalMet` is ignored in both directions.
//
// It used to be a hint that could raise the verdict but not lower it. Raising
// was the half nobody questioned, and it was the loophole: `goalMet: true` on a
// 100-step payload set the day's goal as met — the streak moved, the goal flag
// was stored, and the step-goal coins were one config switch away. Accounts in
// the data had goalMet stored on days of 4,500/10,000 and 15,000/20,000. A
// client can only ever be BEHIND the server on this question (it cannot see
// bonus steps, a clamp, or the current goal), so there is nothing its vote adds.
//
// This was `goalMet ?? (totalSteps >= dailyGoal)` inside syncHealthData. `??`
// falls through only on null/undefined, so `false ?? x` is `false` — and three
// callers posted a hardcoded `goalMet: false` on payloads that had no business
// voting on it: the water-intake calls in hydration.service.ts (payloads carrying
// no steps at all), the JS background sync, and the native HealthSyncHelper
// worker, the last two under a comment reading "server recalculates", which it
// therefore did not. Two consequences:
//
//   * A glass of water logged after the user hit 15,000 steps flipped that day's
//     stored goalMet back to false, so the calendar and day-detail screens
//     reported the goal as missed.
//   * A user who only ever syncs in the background never satisfied the condition
//     that awards the daily step-goal coins, and never reached _updateStreak — so
//     no coins and a streak stuck at 0, however far they walked.
//
// Those callers now omit the field, but the rule belongs here regardless: a client
// that cannot see bonus steps or the user's current goal must not be able to veto
// this. It also keeps one definition of "goal met" in one place — having two is
// what let them disagree in the first place.
//
// Lives in utils rather than in the controller so it is testable: requiring
// health.controller.js pulls in the push-notification stack and initialises
// firebase-admin, which needs live service-account credentials.

/**
 * @param {object} params
 * @param {number} params.totalSteps Walked + bonus steps for the day.
 * @param {number} params.dailyGoal The user's step goal for the day.
 * @param {boolean|undefined|null} [params.clientGoalMet] Accepted for older
 *   callers and ignored — see the header.
 * @returns {boolean}
 */
function resolveGoalMet({ totalSteps, dailyGoal }) {
  return totalSteps >= dailyGoal;
}

module.exports = { resolveGoalMet };
