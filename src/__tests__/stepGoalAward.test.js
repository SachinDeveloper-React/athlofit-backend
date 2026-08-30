// Both step-goal award paths used to compute an amount and then claim the day
// regardless of whether that amount was zero. Claiming the day is not just
// bookkeeping: `stepGoalCoinDate` is the idempotency key POST /gamification/
// rewards/claim checks, so a zero-value claim permanently denies the user that
// day's bonus by hand as well, and `retroGoalCoinAwarded` does the same for the
// past-date path.
//
// With `rewards.stepGoalCoins` set to 0 — the live configuration — that was
// happening to every goal-meeting user every day.

const { resolveStepGoalAward } = require('../utils/stepGoalAward');

describe('resolveStepGoalAward', () => {
  it('pays the configured bonus when the cap leaves room', () => {
    const result = resolveStepGoalAward({
      stepGoalCoins: 50,
      effectiveCap: 250,
      coinsEarnedToday: 10,
    });

    expect(result).toEqual({ coins: 50, shouldClaim: true });
  });

  // ── The regression ────────────────────────────────────────────────────────
  it('does not claim the day when the bonus is switched off', () => {
    const result = resolveStepGoalAward({
      stepGoalCoins: 0,
      effectiveCap: 250,
      coinsEarnedToday: 0,
    });

    expect(result.coins).toBe(0);
    // The whole point: no claim, so stepGoalCoinDate stays free and the day can
    // still be paid if the bonus is switched back on.
    expect(result.shouldClaim).toBe(false);
  });

  it('does not claim the day when the cap is already exhausted', () => {
    const result = resolveStepGoalAward({
      stepGoalCoins: 50,
      effectiveCap: 50,
      coinsEarnedToday: 50,
    });

    expect(result).toEqual({ coins: 0, shouldClaim: false });
  });

  it('pays only what is left under the cap', () => {
    const result = resolveStepGoalAward({
      stepGoalCoins: 50,
      effectiveCap: 50,
      coinsEarnedToday: 20,
    });

    expect(result).toEqual({ coins: 30, shouldClaim: true });
  });

  it('claims a partial award, since a partial award is still an award', () => {
    // Rounding must not turn a payable fraction into a silent zero-claim.
    const result = resolveStepGoalAward({
      stepGoalCoins: 50,
      effectiveCap: 50,
      coinsEarnedToday: 49.4,
    });

    expect(result.coins).toBe(1);
    expect(result.shouldClaim).toBe(true);
  });

  it('rounds a sub-half remainder down to nothing and refuses to claim', () => {
    const result = resolveStepGoalAward({
      stepGoalCoins: 50,
      effectiveCap: 50,
      coinsEarnedToday: 49.8,
    });

    expect(result).toEqual({ coins: 0, shouldClaim: false });
  });

  it('never pays a negative amount when the cap is already overshot', () => {
    const result = resolveStepGoalAward({
      stepGoalCoins: 50,
      effectiveCap: 50,
      coinsEarnedToday: 300,
    });

    expect(result).toEqual({ coins: 0, shouldClaim: false });
  });

  it('skips the cap entirely when none is given, as the retro path does', () => {
    const result = resolveStepGoalAward({ stepGoalCoins: 50 });

    expect(result).toEqual({ coins: 50, shouldClaim: true });
  });

  it('still refuses to claim an uncapped award of zero', () => {
    expect(resolveStepGoalAward({ stepGoalCoins: 0 })).toEqual({
      coins: 0,
      shouldClaim: false,
    });
  });

  it('treats a missing or nonsense configured bonus as nothing to pay', () => {
    for (const stepGoalCoins of [undefined, null, NaN, -50, 'abc']) {
      const result = resolveStepGoalAward({ stepGoalCoins, effectiveCap: 250 });
      expect(result).toEqual({ coins: 0, shouldClaim: false });
    }
  });

  it('tolerates a missing coinsEarnedToday', () => {
    const result = resolveStepGoalAward({
      stepGoalCoins: 50,
      effectiveCap: 250,
      coinsEarnedToday: undefined,
    });

    expect(result).toEqual({ coins: 50, shouldClaim: true });
  });

  // ── How the retroactive path uses the cap ─────────────────────────────────
  // It cannot pass `coinsEarnedToday` — that counts TODAY's earnings, and the
  // award belongs to a past date — so it reconstructs that date's own step
  // earnings from its final step total and charges the bonus against those.
  describe('retroactive usage — the cap is charged against that date', () => {
    it('pays the full bonus when the past date left room under the cap', () => {
      // 44,012 steps at 0.095/100 earned that date about 41.8 coins.
      const result = resolveStepGoalAward({
        stepGoalCoins: 50,
        effectiveCap: 250,
        coinsEarnedToday: 41.8,
      });

      expect(result).toEqual({ coins: 50, shouldClaim: true });
    });

    it('trims the bonus when that date had already filled its cap', () => {
      // Same day for an unverified user, whose ceiling is 50.
      const result = resolveStepGoalAward({
        stepGoalCoins: 50,
        effectiveCap: 50,
        coinsEarnedToday: 41.8,
      });

      expect(result).toEqual({ coins: 8, shouldClaim: true });
    });

    it('refuses the claim outright when that date is already at the ceiling', () => {
      const result = resolveStepGoalAward({
        stepGoalCoins: 50,
        effectiveCap: 50,
        coinsEarnedToday: 50,
      });

      // The retro path must not set retroGoalCoinAwarded here — the date would
      // become permanently unpayable for a bonus it never received.
      expect(result.shouldClaim).toBe(false);
    });
  });

  it('never reports coins without also reporting a claim, or vice versa', () => {
    const cases = [
      { stepGoalCoins: 0, effectiveCap: 250, coinsEarnedToday: 0 },
      { stepGoalCoins: 50, effectiveCap: 250, coinsEarnedToday: 0 },
      { stepGoalCoins: 50, effectiveCap: 50, coinsEarnedToday: 50 },
      { stepGoalCoins: 50, effectiveCap: 0, coinsEarnedToday: 0 },
      { stepGoalCoins: 20, effectiveCap: 250, coinsEarnedToday: 240 },
    ];

    for (const input of cases) {
      const { coins, shouldClaim } = resolveStepGoalAward(input);
      expect(shouldClaim).toBe(coins > 0);
      expect(coins).toBeGreaterThanOrEqual(0);
    }
  });
});
