// Tests for the shared daily coin ceiling.
//
// The bug these exist for: challenge rewards credited `challenge.coinReward` in
// full with no cap check of any kind, and never added it to `coinsEarnedToday`.
// Both halves mattered. Uncapped, the fifteen seeded daily challenges alone are
// worth 675 coins against a configured 250; and because the coins never reached
// `coinsEarnedToday`, they did not consume the allowance the step-goal and
// hydration claims measure themselves against either — so challenge coins were
// invisible to every cap in the system, including their own.
//
// The rule now lives in one place instead of being restated per call site. That
// is the other half of the fix: `getEffectiveDailyCap` existed as two identical
// private copies, and a third caller was about to make it three.

const {
  getEffectiveDailyCap,
  allowanceFor,
  describeDailyRewardCap,
} = require('../utils/dailyCoinCap');
const {
  DEFAULT_MAX_DAILY_REWARDS,
  DEFAULT_UNVERIFIED_DAILY_CAP,
} = require('../constants/coinDefaults');

const verified = { emailVerified: true };
const unverified = { emailVerified: false };

describe('getEffectiveDailyCap', () => {
  it('gives a verified user the configured ceiling', () => {
    expect(getEffectiveDailyCap(verified, 950, 50)).toBe(950);
  });

  it('holds an unverified user to the lower fraud cap', () => {
    expect(getEffectiveDailyCap(unverified, 950, 50)).toBe(50);
  });

  it('never lets the unverified cap RAISE the ceiling', () => {
    // A misconfiguration where unverifiedDailyCap exceeds maxDailyRewards must
    // not hand unverified accounts more than verified ones get. The unverified
    // cap is a fraud control; it can only ever tighten.
    expect(getEffectiveDailyCap(unverified, 100, 5_000)).toBe(100);
  });

  it('falls back to the shared constants when config is absent', () => {
    expect(getEffectiveDailyCap(verified, undefined, undefined)).toBe(
      DEFAULT_MAX_DAILY_REWARDS,
    );
    expect(getEffectiveDailyCap(unverified, undefined, undefined)).toBe(
      DEFAULT_UNVERIFIED_DAILY_CAP,
    );
  });

  it('treats a missing user as unverified', () => {
    expect(getEffectiveDailyCap(undefined, 950, 50)).toBe(50);
    expect(getEffectiveDailyCap(null, 950, 50)).toBe(50);
  });
});

describe('allowanceFor', () => {
  it('pays the full reward while the day has room', () => {
    const r = allowanceFor({ requested: 60, coinsEarnedToday: 100, cap: 950 });
    expect(r).toMatchObject({ payable: 60, capped: false });
  });

  it('pays only what is left when the reward crosses the ceiling', () => {
    const r = allowanceFor({ requested: 60, coinsEarnedToday: 930, cap: 950 });
    expect(r).toMatchObject({ payable: 20, remaining: 20, capped: true });
  });

  it('pays nothing once the day is spent, and says so', () => {
    // `capped: true` on a zero payout is what tells the caller not to mark the
    // reward permanently claimed. Without that distinction a challenge completed
    // after the ceiling was marked paid while crediting nothing.
    const r = allowanceFor({ requested: 60, coinsEarnedToday: 950, cap: 950 });
    expect(r).toMatchObject({ payable: 0, capped: true });
  });

  it('never goes negative when the day is already over the ceiling', () => {
    // Reachable: badge rewards bypass the cap by design and are excluded from
    // coinsEarnedToday, but a config lowered mid-day can still leave a user past
    // their new ceiling.
    const r = allowanceFor({ requested: 60, coinsEarnedToday: 2_000, cap: 950 });
    expect(r.payable).toBe(0);
    expect(r.remaining).toBe(0);
  });

  it('handles fractional passive-coin amounts without drift', () => {
    const r = allowanceFor({ requested: 0.0475, coinsEarnedToday: 0, cap: 950 });
    expect(r.payable).toBe(0.0475);
  });
});

// ─── The whole point, stated as arithmetic ───────────────────────────────────
describe('a day of rewards no longer exceeds the ceiling', () => {
  // Awards, in the order a real day produces them.
  const day = [
    { name: 'passive step coins', amount: 200 },
    { name: 'daily step goal', amount: 50 },
    { name: 'hydration goal', amount: 20 },
    // The fifteen seeded daily challenges.
    ...[30, 60, 40, 150, 35, 60, 35, 20, 35, 50, 25, 40, 30, 45, 20].map(
      (amount, i) => ({ name: `challenge ${i + 1}`, amount }),
    ),
  ];

  const runDay = cap => {
    let earned = 0;
    let paidInFull = 0;
    for (const award of day) {
      const { payable, capped } = allowanceFor({
        requested: award.amount,
        coinsEarnedToday: earned,
        cap,
      });
      earned += payable;
      if (!capped) paidInFull += 1;
    }
    return { earned, paidInFull };
  };

  it('sums to 945 across every source', () => {
    expect(day.reduce((s, a) => s + a.amount, 0)).toBe(945);
  });

  it('at the raised ceiling, a perfect day is paid in full', () => {
    const { earned, paidInFull } = runDay(950);
    expect(earned).toBe(945);
    expect(paidInFull).toBe(day.length);
  });

  it('at the OLD ceiling, most of the day would have been destroyed', () => {
    // Why the number had to move with the rule. Enforcing 250 pays the user for
    // roughly their first challenge and nothing after — and the challenge award
    // marks isRewarded regardless, so the rest would be lost, not deferred.
    const { earned, paidInFull } = runDay(250);
    expect(earned).toBe(250);
    expect(paidInFull).toBeLessThan(6);
  });

  it('an unverified user is still held to the fraud cap', () => {
    const cap = getEffectiveDailyCap(unverified, 950, 50);
    expect(runDay(cap).earned).toBe(50);
  });

  it('the ceiling binds whatever order the awards arrive in', () => {
    const reversed = [...day].reverse();
    let earned = 0;
    for (const award of reversed) {
      earned += allowanceFor({
        requested: award.amount,
        coinsEarnedToday: earned,
        cap: 500,
      }).payable;
    }
    expect(earned).toBe(500);
  });
});

// ─── Sizing the cap against live content ─────────────────────────────────────
//
// `maxDailyRewards` is one hand-edited number that has to stay sane against
// several others nobody edits with it. Nothing compared them, which is how the
// challenge rewards came to be worth several times the whole cap unnoticed.
describe('describeDailyRewardCap', () => {
  // The live config that prompted this: dailyEarnLimit 219, cap 250.
  const live = {
    maxDailyRewards: 250,
    dailyEarnLimit: 219,
    stepGoalCoins: 50,
    hydrationGoalCoins: 20,
    dailyChallengeCoins: 675,
    weeklyChallengeCoins: 1_690,
  };

  it('adds up what one day can actually pay', () => {
    const r = describeDailyRewardCap(live);
    expect(r.perfectDay).toBe(964); // 219 + 50 + 20 + 675
    expect(r.breakdown).toEqual({
      passiveSteps: 219,
      stepGoal: 50,
      hydrationGoal: 20,
      dailyChallenges: 675,
    });
  });

  it('reports how far the configured cap falls short', () => {
    const r = describeDailyRewardCap(live);
    expect(r.capBinds).toBe(true);
    expect(r.shortfall).toBe(714);
    expect(r.summary).toMatch(/cannot be paid/);
  });

  it('says so when the cap can never bind', () => {
    // The other failure mode, and the one describePassiveCoinCap was written
    // for: a ceiling nothing can reach is a setting that looks like a safety net.
    const r = describeDailyRewardCap({ ...live, maxDailyRewards: 5_000 });
    expect(r.capBinds).toBe(false);
    expect(r.summary).toMatch(/never bind/);
  });

  it('leaves weekly challenges out of the daily total', () => {
    // Each completes at most once a week. A cap sized to fit all ten landing on
    // one day would not bind on any real day.
    const r = describeDailyRewardCap(live);
    expect(r.perfectDay).toBeLessThan(live.weeklyChallengeCoins);
    expect(r.weeklyChallengeCoins).toBe(1_690);
  });

  it('survives a config with nothing set', () => {
    const r = describeDailyRewardCap({ maxDailyRewards: 0 });
    expect(r.perfectDay).toBe(0);
    expect(r.capBinds).toBe(false);
  });
});
