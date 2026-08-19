/**
 * Daily step-goal verdict for POST /health/sync.
 *
 * The rule used to be `goalMet ?? (totalSteps >= dailyGoal)`. `??` falls through
 * only on null/undefined, so a client posting a hardcoded `goalMet: false` won,
 * and three callers did exactly that — the water-intake calls in
 * hydration.service.ts (payloads with no steps in them at all), the JS background
 * sync, and the native HealthSyncHelper worker. That produced two user-visible
 * failures, and each has a test below:
 *
 *   1. Logging a glass of water after reaching the goal reset that day's stored
 *      goalMet flag, so the calendar and day-detail screens reported a missed goal.
 *   2. A user who only ever syncs in the background never satisfied the condition
 *      that awards the daily step-goal coins and never reached _updateStreak, so
 *      they got no coins and a streak permanently at 0.
 *
 * The verdict is the server's: it alone knows the bonus steps folded into
 * totalSteps and the user's current dailyGoal. A client hint may only raise it.
 */
const { resolveGoalMet } = require('../utils/goalMet');

describe('resolveGoalMet', () => {
  const dailyGoal = 8_000;

  describe('the server total decides', () => {
    it.each([
      [8_000, true, 'exactly at the goal'],
      [8_001, true, 'just over the goal'],
      [15_000, true, 'well over the goal'],
      [7_999, false, 'just under the goal'],
      [0, false, 'no steps'],
    ])('%i steps → %s (%s)', (totalSteps, expected) => {
      expect(resolveGoalMet({ totalSteps, dailyGoal, clientGoalMet: undefined }))
        .toBe(expected);
    });
  });

  describe('a client hint can raise the verdict but never lower it', () => {
    it('ignores clientGoalMet:false once the goal is actually met', () => {
      // Regression: the hydration and background-sync payloads.
      expect(resolveGoalMet({ totalSteps: 15_000, dailyGoal, clientGoalMet: false }))
        .toBe(true);
    });

    it('honours clientGoalMet:true when the stored total does not show it', () => {
      expect(resolveGoalMet({ totalSteps: 100, dailyGoal, clientGoalMet: true }))
        .toBe(true);
    });

    it.each([undefined, null, false, 0, '', 'false'])(
      'treats a hint of %p as no vote for the goal being met',
      (clientGoalMet) => {
        expect(resolveGoalMet({ totalSteps: 100, dailyGoal, clientGoalMet }))
          .toBe(false);
      },
    );
  });

  describe('bonus steps count toward the goal', () => {
    // totalSteps is walked + bonus by the time it reaches here, which is what the
    // rest of the system already assumes: goalMet is persisted from this verdict,
    // _updateStreak runs on it, and POST /gamification/coins/earn verifies against
    // the stored total.
    it('a user pushed over the line by bonus steps has met the goal', () => {
      const walked = 6_000;
      const bonus = 2_500;
      expect(resolveGoalMet({ totalSteps: walked + bonus, dailyGoal, clientGoalMet: false }))
        .toBe(true);
    });
  });

  describe('a water log cannot undo a met goal', () => {
    // The end-to-end shape of failure 1: the step sync establishes the goal as met
    // for the day, then a hydration-only sync arrives. It carries no steps, so the
    // controller re-derives totalSteps from the stored row — the same total — and
    // the verdict has to come out the same both times.
    it('re-derives the same verdict for a hydration-only sync', () => {
      const storedTotal = 15_000;

      const afterStepSync = resolveGoalMet({
        totalSteps: storedTotal,
        dailyGoal,
        clientGoalMet: true, // TrackerScreen sends its own computed value
      });
      const afterWaterLog = resolveGoalMet({
        totalSteps: storedTotal, // unchanged: the water payload has no steps
        dailyGoal,
        clientGoalMet: false, // what hydration.service.ts used to send
      });

      expect(afterStepSync).toBe(true);
      expect(afterWaterLog).toBe(true);
    });
  });
});
