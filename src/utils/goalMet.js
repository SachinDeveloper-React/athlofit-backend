// src/utils/goalMet.js
// ─── Was the daily step goal met? ────────────────────────────────────────────
//
// The server decides, because it alone holds the authoritative numbers:
// `totalSteps` is walked + admin-credited bonus, and `dailyGoal` is the user's
// goal as of now. The client's `goalMet` is only a HINT, and it can raise the
// verdict, never lower it.
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
 * @param {boolean|undefined|null} [params.clientGoalMet] The client's hint, if any.
 *   Only an exact `true` counts; anything else leaves the decision to the total.
 * @returns {boolean}
 */
function resolveGoalMet({ totalSteps, dailyGoal, clientGoalMet }) {
  return totalSteps >= dailyGoal || clientGoalMet === true;
}

module.exports = { resolveGoalMet };
