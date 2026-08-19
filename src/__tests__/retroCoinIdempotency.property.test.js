/**
 * Retroactive Step-Coin Idempotency
 *
 * When a background sync pushes steps for a PAST date, the server awards passive
 * step coins plus (once) the daily step-goal bonus for that date. The award must
 * be paid at most once per date no matter how many syncs arrive, in what order,
 * or how they interleave.
 *
 * The bug this pins down:
 *   The old implementation was check-then-act. It looked for a CoinTransaction
 *   row with metadata.date === the target date and, if absent, ran an
 *   unconditional `$inc` on coinsBalance. The row it checked for was written by
 *   logCoinTransaction, which was called WITHOUT await, so it had usually not
 *   been inserted yet when a concurrent sync ran the same check — and the $inc
 *   carried no guard of its own. Two syncs for the same past date could both
 *   observe "not awarded" and both increment the balance.
 *
 *   It also read `existing.stepCoinWatermark`, a field that was never declared on
 *   the HealthActivity schema, so it was always undefined -> 0. Every retro sync
 *   therefore assumed nothing had been paid for that day.
 *
 * The fix models the claim as an atomic compare-and-set on that date's own
 * HealthActivity document (a real `stepCoinWatermark` plus a
 * `retroGoalCoinAwarded` flag), returning the pre-image so the caller can see
 * exactly what had already been paid. This file tests that logic as a pure
 * function, the same approach dailyGoalIdempotency.property.test.js takes.
 */
const fc = require('fast-check');
const { computePassiveCoinDelta } = require('../utils/passiveCoins');

// ─── Model of the atomic claim + award ───────────────────────────────────────
//
// `activity` stands in for the HealthActivity document for the target date and is
// mutated in place, exactly as the single-document atomic update does in Mongo.
// `gam` stands in for the Gamification document.

/**
 * Mirrors the retro award block in health.controller.js.
 *
 * The claim is the atomic step: it matches only when there is something left to
 * pay, and it advances the watermark/flag in the same operation. A caller that
 * does not match gets no pre-image and pays nothing.
 */
function attemptRetroAward({ activity, gam, walkedSteps, goalMet, rate, dailyEarnLimit, stepGoalCoins }) {
  // ── Atomic claim: { $or: conditions } + { $max: watermark, $set: flag } ──
  const hasPassiveToPay = (activity.stepCoinWatermark || 0) < walkedSteps;
  const hasGoalToPay = goalMet && activity.retroGoalCoinAwarded !== true;

  if (!hasPassiveToPay && !hasGoalToPay) {
    return { awarded: 0, passive: 0, goal: 0, balance: gam.coinsBalance, claimed: false };
  }

  // Pre-image, captured before the update is applied ({ new: false }).
  const previousWatermark = Math.max(0, activity.stepCoinWatermark || 0);
  const goalAlreadyPaid = activity.retroGoalCoinAwarded === true;

  // Apply the update.
  activity.stepCoinWatermark = Math.max(previousWatermark, walkedSteps); // $max
  if (goalMet) activity.retroGoalCoinAwarded = true;                     // $set

  // ── Pay only what the pre-image says is outstanding ──────────────────────
  const { coins: retroPassive } = computePassiveCoinDelta({
    currentSteps: walkedSteps,
    watermark: previousWatermark,
    rate,
    dailyEarnLimit,
  });
  const retroGoalCoins = (goalMet && !goalAlreadyPaid) ? stepGoalCoins : 0;
  const totalRetro = parseFloat((retroPassive + retroGoalCoins).toFixed(4));

  if (totalRetro > 0) gam.coinsBalance = parseFloat((gam.coinsBalance + totalRetro).toFixed(4));

  return {
    awarded: totalRetro,
    passive: retroPassive,
    goal: retroGoalCoins,
    balance: gam.coinsBalance,
    claimed: true,
  };
}

const freshActivity = () => ({ stepCoinWatermark: 0, retroGoalCoinAwarded: false });
const freshGam = (balance = 0) => ({ coinsBalance: balance });

const RATE = 0.5;
const CAP = 200;
const GOAL_COINS = 50;

describe('retro step-coin award — idempotency', () => {
  it('pays exactly once across N identical syncs for the same past date', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 50 }),
        fc.integer({ min: 100, max: 40000 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 5000 }),
        (attempts, walkedSteps, goalMet, startingBalance) => {
          const activity = freshActivity();
          const gam = freshGam(startingBalance);

          const results = [];
          for (let i = 0; i < attempts; i++) {
            results.push(
              attemptRetroAward({
                activity, gam,
                walkedSteps, goalMet,
                rate: RATE, dailyEarnLimit: CAP, stepGoalCoins: GOAL_COINS,
              }),
            );
          }

          // Exactly one attempt may pay out.
          const paying = results.filter(r => r.awarded > 0);
          expect(paying.length).toBeLessThanOrEqual(1);

          // The balance equals the starting balance plus one single award.
          const expectedAward = parseFloat((
            computePassiveCoinDelta({ currentSteps: walkedSteps, watermark: 0, rate: RATE, dailyEarnLimit: CAP }).coins +
            (goalMet ? GOAL_COINS : 0)
          ).toFixed(4));
          expect(gam.coinsBalance).toBeCloseTo(startingBalance + expectedAward, 4);

          // Every attempt after the first is a no-op on the balance.
          const balanceAfterFirst = results[0].balance;
          for (let i = 1; i < results.length; i++) {
            expect(results[i].awarded).toBe(0);
            expect(results[i].balance).toBe(balanceAfterFirst);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never pays the goal bonus more than once, even as steps keep growing', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 100, max: 40000 }), { minLength: 2, maxLength: 20 }),
        (rawSteps) => {
          // Steps arriving in increasing order, as a day's syncs would.
          const series = [...rawSteps].sort((a, b) => a - b);
          const activity = freshActivity();
          const gam = freshGam(0);

          // Count the flat goal bonus directly from the award breakdown. Inferring
          // it from the balance delta does not work: a large passive increment can
          // exceed GOAL_COINS on its own.
          let goalPayments = 0;
          for (const walked of series) {
            const r = attemptRetroAward({
              activity, gam,
              walkedSteps: walked, goalMet: true,
              rate: RATE, dailyEarnLimit: CAP, stepGoalCoins: GOAL_COINS,
            });
            if (r.goal > 0) goalPayments++;
          }

          expect(goalPayments).toBe(1);
          expect(activity.retroGoalCoinAwarded).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('total paid never exceeds the coins owed for the highest step count seen', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 40000 }), { minLength: 1, maxLength: 25 }),
        fc.boolean(),
        (series, goalMet) => {
          const activity = freshActivity();
          const gam = freshGam(0);

          // Arbitrary order, including decreases — a later sync can legitimately
          // report fewer steps than an earlier one (different device, correction).
          for (const walked of series) {
            attemptRetroAward({
              activity, gam,
              walkedSteps: walked, goalMet,
              rate: RATE, dailyEarnLimit: CAP, stepGoalCoins: GOAL_COINS,
            });
          }

          const peak = Math.max(...series);
          const owed = parseFloat((
            computePassiveCoinDelta({ currentSteps: peak, watermark: 0, rate: RATE, dailyEarnLimit: CAP }).coins +
            (goalMet ? GOAL_COINS : 0)
          ).toFixed(4));

          // Never more than owed for the peak — a decrease must not refund and
          // re-mint, which is what an unguarded watermark would allow.
          expect(gam.coinsBalance).toBeLessThanOrEqual(owed + 1e-6);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a growing step count pays only the incremental difference', () => {
    const activity = freshActivity();
    const gam = freshGam(0);

    // 1,000 steps -> 10 * 0.5 = 5 coins
    const first = attemptRetroAward({
      activity, gam, walkedSteps: 1000, goalMet: false,
      rate: RATE, dailyEarnLimit: CAP, stepGoalCoins: GOAL_COINS,
    });
    expect(first.awarded).toBeCloseTo(5, 4);

    // 1,500 steps -> owed 7.5 total, 5 already paid, so 2.5 more
    const second = attemptRetroAward({
      activity, gam, walkedSteps: 1500, goalMet: false,
      rate: RATE, dailyEarnLimit: CAP, stepGoalCoins: GOAL_COINS,
    });
    expect(second.awarded).toBeCloseTo(2.5, 4);
    expect(gam.coinsBalance).toBeCloseTo(7.5, 4);

    // Same count again -> nothing
    const third = attemptRetroAward({
      activity, gam, walkedSteps: 1500, goalMet: false,
      rate: RATE, dailyEarnLimit: CAP, stepGoalCoins: GOAL_COINS,
    });
    expect(third.awarded).toBe(0);
    expect(gam.coinsBalance).toBeCloseTo(7.5, 4);
  });

  it('still pays for a document written before the watermark field existed', () => {
    // Rows created before stepCoinWatermark was added to the schema have the field
    // absent, not 0. The claim query has explicit null / $exists:false arms for
    // exactly this case — a missing field does not match `$lt` against a number in
    // MQL, so without them retro awards would silently stop for every existing row.
    const legacyActivity = {}; // no stepCoinWatermark, no retroGoalCoinAwarded
    const gam = freshGam(0);

    const result = attemptRetroAward({
      activity: legacyActivity, gam, walkedSteps: 2000, goalMet: false,
      rate: RATE, dailyEarnLimit: CAP, stepGoalCoins: GOAL_COINS,
    });

    expect(result.awarded).toBeCloseTo(10, 4); // 2,000 steps = 20 * 0.5
    expect(legacyActivity.stepCoinWatermark).toBe(2000);

    // And it is idempotent from then on.
    const again = attemptRetroAward({
      activity: legacyActivity, gam, walkedSteps: 2000, goalMet: false,
      rate: RATE, dailyEarnLimit: CAP, stepGoalCoins: GOAL_COINS,
    });
    expect(again.awarded).toBe(0);
  });

  it('a same-day award already recorded on the date blocks a later retro double-pay', () => {
    // This is the regression the old code hit: the date received coins from the
    // normal same-day path (late-night sync), then after midnight the same date
    // was re-synced as a past date. With the watermark mirrored onto the date's
    // own document, the retro path can see what was already paid.
    const activity = { stepCoinWatermark: 8000, retroGoalCoinAwarded: true };
    const gam = freshGam(100);

    const result = attemptRetroAward({
      activity, gam, walkedSteps: 8000, goalMet: true,
      rate: RATE, dailyEarnLimit: CAP, stepGoalCoins: GOAL_COINS,
    });

    expect(result.awarded).toBe(0);
    expect(gam.coinsBalance).toBe(100);
  });

  it('concurrent syncs interleaved on one document still pay once', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 40000 }),
        fc.integer({ min: 2, max: 10 }),
        (walkedSteps, concurrency) => {
          const activity = freshActivity();
          const gam = freshGam(0);

          // Each "request" evaluates its claim against the shared document. The
          // atomic claim is what serialises them: the first mutates the
          // watermark, so the rest find nothing outstanding.
          const awards = Array.from({ length: concurrency }, () =>
            attemptRetroAward({
              activity, gam, walkedSteps, goalMet: true,
              rate: RATE, dailyEarnLimit: CAP, stepGoalCoins: GOAL_COINS,
            }).awarded,
          );

          expect(awards.filter(a => a > 0).length).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('passive coin basis — walked vs total steps', () => {
  // The health sync computes the watermark from WALKED steps while the cron used
  // to compute it from `activity.steps` (walked + bonus). Both write the same
  // field, so the mismatch made the sync's own comparison unsatisfiable for the
  // rest of the day and real walking stopped earning.
  const walkedFrom = (activity) =>
    Math.max(0, (activity.steps || 0) - (activity.bonusSteps || 0));

  it('cron and sync derive the same watermark basis', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40000 }),
        fc.integer({ min: 0, max: 10000 }),
        (walked, bonus) => {
          const activity = { steps: walked + bonus, bonusSteps: bonus };
          // What the cron now uses must equal what the sync uses (walked steps).
          expect(walkedFrom(activity)).toBe(walked);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('walking after a bonus credit still earns — the starvation case', () => {
    const rate = RATE;
    const cap = CAP;

    // User walked 5,000 and was credited 3,000 bonus steps.
    const activity = { steps: 8000, bonusSteps: 3000 };

    // Old cron basis: total (8,000) -> watermark lands at 8,000.
    const oldWatermark = activity.steps;
    // The sync then compares its walked figure against that watermark.
    const walkedNow = 6000; // user walked another 1,000
    const oldDelta = computePassiveCoinDelta({
      currentSteps: walkedNow, watermark: oldWatermark, rate, dailyEarnLimit: cap,
    }).coins;
    expect(oldDelta).toBe(0); // starved: real steps earn nothing

    // New basis: walked only (5,000) -> the extra 1,000 steps are paid.
    const newWatermark = walkedFrom(activity);
    expect(newWatermark).toBe(5000);
    const newDelta = computePassiveCoinDelta({
      currentSteps: walkedNow, watermark: newWatermark, rate, dailyEarnLimit: cap,
    }).coins;
    expect(newDelta).toBeCloseTo(5, 4); // 1,000 steps = 10 * 0.5
  });
});
