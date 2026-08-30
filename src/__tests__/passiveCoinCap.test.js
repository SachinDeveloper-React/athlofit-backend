// The passive daily cap and the per-step rate are stored as independent config
// fields and nothing compared them, so `dailyEarnLimit` silently stopped being
// reachable: at 0.095 coins per 100 steps a day tops out at 47.5 coins, against
// a configured limit of 200. A cap that cannot be hit is not a safety net, and
// the only way anyone would have found out is by reading payouts.
//
// These cover the helpers that make the relationship computable, so the boot log
// and the admin PATCH response can say which of the two levers is actually in
// charge.

const {
  maxAchievablePassiveCoins,
  describePassiveCoinCap,
  passiveCoinsForSteps,
} = require('../utils/passiveCoins');
const { MAX_DAILY_STEPS } = require('../utils/stepValidation');

describe('maxAchievablePassiveCoins', () => {
  it('matches what a maximum day actually pays', () => {
    const rate = 0.095;
    // The same figure the award path would compute for a capped-out day.
    const viaAwardPath = passiveCoinsForSteps(MAX_DAILY_STEPS, rate, Infinity);

    expect(maxAchievablePassiveCoins(rate)).toBe(viaAwardPath);
    expect(maxAchievablePassiveCoins(rate)).toBe(47.5);
  });

  it('scales with the rate', () => {
    expect(maxAchievablePassiveCoins(0.5)).toBe(250);
    expect(maxAchievablePassiveCoins(1)).toBe(500);
  });

  it('is bounded by the step ceiling, not by wishful step counts', () => {
    // Steps above the anti-cheat's daily cap are never accepted, so they cannot
    // contribute to the maximum either.
    expect(maxAchievablePassiveCoins(0.095, 500_000)).toBeGreaterThan(
      maxAchievablePassiveCoins(0.095),
    );
    expect(maxAchievablePassiveCoins(0.095, MAX_DAILY_STEPS)).toBe(47.5);
  });

  it('treats a zero or negative rate as paying nothing', () => {
    expect(maxAchievablePassiveCoins(0)).toBe(0);
    expect(maxAchievablePassiveCoins(-1)).toBe(0);
  });
});

describe('describePassiveCoinCap', () => {
  it('reports the live configuration as a cap that cannot bind', () => {
    const state = describePassiveCoinCap(0.095, 200);

    expect(state.capBinds).toBe(false);
    expect(state.maxAchievable).toBe(47.5);
    expect(state.summary).toMatch(/can never bind/);
  });

  it('reports a binding cap when the rate is high enough to reach it', () => {
    const state = describePassiveCoinCap(0.5, 200);

    expect(state.capBinds).toBe(true);
    expect(state.maxAchievable).toBe(250);
    expect(state.summary).toMatch(/binds/);
  });

  it('does not call an exactly-reachable cap binding', () => {
    // 0.4/100 steps pays exactly 200 on a maximum day. The cap never actually
    // subtracts anything, so calling it binding would be misleading.
    const state = describePassiveCoinCap(0.4, 200);

    expect(state.maxAchievable).toBe(200);
    expect(state.capBinds).toBe(false);
  });

  it('carries both inputs back so the caller can log them together', () => {
    const state = describePassiveCoinCap(0.095, 200);

    expect(state.rate).toBe(0.095);
    expect(state.dailyEarnLimit).toBe(200);
  });
});
