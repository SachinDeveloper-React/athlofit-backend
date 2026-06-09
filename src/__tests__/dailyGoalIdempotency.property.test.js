/**
 * Property 2: Daily Goal Idempotency
 *
 * Multiple calls to claim within the same calendar day result in exactly one
 * successful award; subsequent calls return an error without modifying the balance.
 *
 * **Validates: Requirements 3.1, 3.2**
 */
const fc = require('fast-check');

// ─── Extracted claim logic (mirrors the claimReward controller logic) ────────
// We extract the core idempotency logic from the controller to test it as a
// pure function without needing Express req/res or MongoDB connections.

/**
 * Simulates the claimReward('steps_daily') logic for a single call.
 * Returns { success, balance, gam } after the attempt.
 */
function attemptStepDailyClaim({ gam, cfg, todaySteps, dailyGoal, today }) {
  const coinValue =
    cfg.coin_config?.rewards?.daily_step_goal_reached?.coin_value ??
    cfg.rewards.stepGoalCoins;
  const enabled =
    cfg.coin_config?.rewards?.daily_step_goal_reached?.enabled ?? true;
  const maxDailyCoins = cfg.coin.maxDailyRewards;

  // Check if reward is disabled
  if (!enabled) {
    return {
      success: false,
      error: 'Daily step goal reward is currently disabled',
      balance: gam.coinsBalance,
      gam,
    };
  }

  // Check isMet — steps must meet goal
  if (todaySteps < dailyGoal) {
    return {
      success: false,
      error: 'Reward threshold not yet reached',
      balance: gam.coinsBalance,
      gam,
    };
  }

  // Check isAlreadyClaimed — lastCoinDate === today means already claimed
  if (gam.lastCoinDate === today) {
    return {
      success: false,
      error: 'Reward already claimed',
      balance: gam.coinsBalance,
      gam,
    };
  }

  // Award the coins (apply daily cap)
  const remainingAllowance = maxDailyCoins - (gam.coinsEarnedToday || 0);
  const actualCoins = Math.round(Math.min(coinValue, remainingAllowance));

  const updatedGam = {
    ...gam,
    coinsBalance: Math.round(gam.coinsBalance + actualCoins),
    coinsEarnedToday: Math.round((gam.coinsEarnedToday || 0) + actualCoins),
    lastCoinDate: today,
  };

  return {
    success: true,
    awarded: actualCoins,
    balance: updatedGam.coinsBalance,
    gam: updatedGam,
  };
}

/**
 * Runs N claim attempts sequentially, threading the gam state through.
 * Returns an array of results.
 */
function runMultipleClaims(n, { gam, cfg, todaySteps, dailyGoal, today }) {
  const results = [];
  let currentGam = { ...gam };

  for (let i = 0; i < n; i++) {
    const result = attemptStepDailyClaim({
      gam: currentGam,
      cfg,
      todaySteps,
      dailyGoal,
      today,
    });
    results.push(result);
    currentGam = result.gam;
  }

  return results;
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 2: Daily Goal Idempotency', () => {
  // Generator for a valid coin_value (non-negative integer, reasonable range)
  const coinValueArb = fc.integer({ min: 1, max: 10000 });

  // Generator for number of claim attempts (at least 2 to test idempotency)
  const claimCountArb = fc.integer({ min: 2, max: 50 });

  // Generator for initial balance (non-negative)
  const balanceArb = fc.integer({ min: 0, max: 1000000 });

  // Generator for daily step goal
  const dailyGoalArb = fc.integer({ min: 1000, max: 50000 });

  // Generator for today's steps (will be constrained to be >= dailyGoal)
  const stepsAboveGoalArb = fc.integer({ min: 0, max: 50000 });

  // Generator for maxDailyRewards (must be positive)
  const maxDailyArb = fc.integer({ min: 1, max: 100000 });

  // Generator for coinsEarnedToday (non-negative, less than max)
  const earnedTodayArb = fc.integer({ min: 0, max: 50000 });

  it('exactly one claim succeeds out of N attempts on the same day', () => {
    fc.assert(
      fc.property(
        claimCountArb,
        coinValueArb,
        balanceArb,
        dailyGoalArb,
        stepsAboveGoalArb,
        maxDailyArb,
        earnedTodayArb,
        (n, coinValue, initialBalance, dailyGoal, extraSteps, maxDaily, earnedToday) => {
          // Ensure steps meet the goal
          const todaySteps = dailyGoal + extraSteps;
          // Ensure earnedToday doesn't exceed maxDaily
          const cappedEarnedToday = Math.min(earnedToday, maxDaily - 1);

          const cfg = {
            coin_config: {
              rewards: {
                daily_step_goal_reached: {
                  enabled: true,
                  coin_value: coinValue,
                },
              },
            },
            rewards: { stepGoalCoins: coinValue },
            coin: { maxDailyRewards: maxDaily },
          };

          const gam = {
            coinsBalance: initialBalance,
            coinsEarnedToday: cappedEarnedToday,
            lastCoinDate: null, // not yet claimed today
          };

          const today = '2025-01-15';
          const results = runMultipleClaims(n, {
            gam,
            cfg,
            todaySteps,
            dailyGoal,
            today,
          });

          // Property: exactly one successful claim
          const successes = results.filter((r) => r.success);
          expect(successes.length).toBe(1);

          // Property: all subsequent attempts fail
          const failures = results.filter((r) => !r.success);
          expect(failures.length).toBe(n - 1);

          // Property: first attempt is the successful one
          expect(results[0].success).toBe(true);

          // Property: all failures after the first have the "already claimed" error
          for (let i = 1; i < results.length; i++) {
            expect(results[i].success).toBe(false);
            expect(results[i].error).toBe('Reward already claimed');
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('balance only changes once regardless of number of claim attempts', () => {
    fc.assert(
      fc.property(
        claimCountArb,
        coinValueArb,
        balanceArb,
        dailyGoalArb,
        stepsAboveGoalArb,
        maxDailyArb,
        (n, coinValue, initialBalance, dailyGoal, extraSteps, maxDaily) => {
          const todaySteps = dailyGoal + extraSteps;

          const cfg = {
            coin_config: {
              rewards: {
                daily_step_goal_reached: {
                  enabled: true,
                  coin_value: coinValue,
                },
              },
            },
            rewards: { stepGoalCoins: coinValue },
            coin: { maxDailyRewards: maxDaily },
          };

          const gam = {
            coinsBalance: initialBalance,
            coinsEarnedToday: 0,
            lastCoinDate: null,
          };

          const today = '2025-01-15';
          const results = runMultipleClaims(n, {
            gam,
            cfg,
            todaySteps,
            dailyGoal,
            today,
          });

          // Expected awarded amount (capped by daily allowance)
          const expectedAwarded = Math.round(Math.min(coinValue, maxDaily));
          const expectedFinalBalance = Math.round(initialBalance + expectedAwarded);

          // Property: final balance equals initial + one award only
          const finalGam = results[results.length - 1].gam;
          expect(finalGam.coinsBalance).toBe(expectedFinalBalance);

          // Property: balance is the same after the first claim for all subsequent ones
          for (let i = 1; i < results.length; i++) {
            expect(results[i].balance).toBe(expectedFinalBalance);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('second claim attempt never modifies the gam state', () => {
    fc.assert(
      fc.property(
        coinValueArb,
        balanceArb,
        dailyGoalArb,
        stepsAboveGoalArb,
        maxDailyArb,
        (coinValue, initialBalance, dailyGoal, extraSteps, maxDaily) => {
          const todaySteps = dailyGoal + extraSteps;

          const cfg = {
            coin_config: {
              rewards: {
                daily_step_goal_reached: {
                  enabled: true,
                  coin_value: coinValue,
                },
              },
            },
            rewards: { stepGoalCoins: coinValue },
            coin: { maxDailyRewards: maxDaily },
          };

          const gam = {
            coinsBalance: initialBalance,
            coinsEarnedToday: 0,
            lastCoinDate: null,
          };

          const today = '2025-01-15';
          const results = runMultipleClaims(3, {
            gam,
            cfg,
            todaySteps,
            dailyGoal,
            today,
          });

          // After first successful claim, state should be set
          const stateAfterFirst = results[0].gam;

          // State after second and third should be identical to state after first
          expect(results[1].gam).toEqual(stateAfterFirst);
          expect(results[2].gam).toEqual(stateAfterFirst);
        }
      ),
      { numRuns: 200 }
    );
  });
});
