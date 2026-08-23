// Badge ELIGIBILITY and badge PAYMENT are two different states, and collapsing
// them into one flag broke the entire streak reward system in a way nobody
// could see from the outside:
//
//   1. _updateStreak runs on every health sync and calls awardBadges(), which
//      set `unlocked = true`.
//   2. claimReward read that same `unlocked` flag as "already claimed" and
//      returned 400.
//   3. A notification told the user they had earned the coins.
//
// Net effect: no user has ever received a streak badge reward, while being told
// they had. These tests pin the separation so the two states cannot be merged
// back together.

const Gamification = require('../models/Gamification.model');

const gam = (badgeList = []) => new Gamification({ user: '000000000000000000000001', badgeList });

describe('badge eligibility vs payment', () => {
  it('awardBadges marks eligibility without marking payment', async () => {
    const g = gam();
    g.streakDays = 30;
    g.awardBadges([{ key: 'streak_30', threshold: 30, coinReward: 800 }]);

    expect(g.isBadgeUnlocked('streak_30')).toBe(true);
    // The assertion that matters: reaching the milestone must NOT look like
    // having been paid for it.
    expect(g.isBadgeClaimed('streak_30')).toBe(false);
  });

  it('does not mark eligibility below the threshold', async () => {
    const g = gam();
    g.streakDays = 29;
    g.awardBadges([{ key: 'streak_30', threshold: 30, coinReward: 800 }]);
    expect(g.isBadgeUnlocked('streak_30')).toBe(false);
    expect(g.isBadgeClaimed('streak_30')).toBe(false);
  });

  it('markBadgeClaimed sets payment and leaves eligibility intact', () => {
    const g = gam();
    g.streakDays = 30;
    g.awardBadges([{ key: 'streak_30', threshold: 30, coinReward: 800 }]);
    g.markBadgeClaimed('streak_30');

    expect(g.isBadgeClaimed('streak_30')).toBe(true);
    expect(g.isBadgeUnlocked('streak_30')).toBe(true);
  });

  it('markBadgeClaimed works on a badge never seen by awardBadges', () => {
    // Direct claim path, where no prior entry exists.
    const g = gam();
    g.markBadgeClaimed('streak_7');
    expect(g.isBadgeClaimed('streak_7')).toBe(true);
    expect(g.isBadgeUnlocked('streak_7')).toBe(true);
  });

  it('repeated awardBadges never flips the payment flag back', () => {
    // Health sync calls awardBadges constantly. It must be inert once paid.
    const g = gam();
    g.streakDays = 30;
    const defs = [{ key: 'streak_30', threshold: 30, coinReward: 800 }];
    g.awardBadges(defs);
    g.markBadgeClaimed('streak_30');
    g.awardBadges(defs);
    g.awardBadges(defs);
    expect(g.isBadgeClaimed('streak_30')).toBe(true);
  });

  it('treats a pre-existing unlocked-but-unpaid badge as claimable', () => {
    // Every user in the database today is in exactly this state: awardBadges
    // unlocked their badges and nothing ever paid. They must be able to claim.
    const g = gam([{ key: 'streak_7', unlocked: true, unlockedAt: new Date() }]);
    expect(g.isBadgeUnlocked('streak_7')).toBe(true);
    expect(g.isBadgeClaimed('streak_7')).toBe(false);
  });

  it('reports unknown badges as neither eligible nor paid', () => {
    const g = gam();
    expect(g.isBadgeUnlocked('nope')).toBe(false);
    expect(g.isBadgeClaimed('nope')).toBe(false);
  });
});

// ─── Payout eligibility ──────────────────────────────────────────────────────
//
// Coin payouts for streak badges are off. The requirement is specifically that
// turning them ON later must NOT release the historical backlog — only
// milestones reached after the switch is flipped may pay. That only works if
// eligibility is decided once, at unlock time, and never re-read.

describe('badge payout eligibility', () => {
  const defs = [{ key: 'streak_30', threshold: 30, coinReward: 800 }];

  it('marks a badge unlocked while payouts are OFF as never payable', () => {
    const g = gam();
    g.streakDays = 30;
    g.awardBadges(defs, { payoutEnabled: false });

    expect(g.isBadgeUnlocked('streak_30')).toBe(true);   // still earned
    expect(g.isBadgePayoutEligible('streak_30')).toBe(false); // but worth nothing
  });

  it('marks a badge unlocked while payouts are ON as payable', () => {
    const g = gam();
    g.streakDays = 30;
    g.awardBadges(defs, { payoutEnabled: true });
    expect(g.isBadgePayoutEligible('streak_30')).toBe(true);
  });

  it('does NOT retroactively make an old badge payable when payouts are enabled', () => {
    // The whole point. Earned while off, then the flag is turned on and health
    // sync re-runs awardBadges — this badge must stay unpayable.
    const g = gam();
    g.streakDays = 30;
    g.awardBadges(defs, { payoutEnabled: false });

    g.awardBadges(defs, { payoutEnabled: true });
    g.awardBadges(defs, { payoutEnabled: true });

    expect(g.isBadgePayoutEligible('streak_30')).toBe(false);
  });

  it('pays only the milestones crossed after the switch is flipped', () => {
    const all = [
      { key: 'streak_7', threshold: 7, coinReward: 200 },
      { key: 'streak_30', threshold: 30, coinReward: 800 },
    ];
    const g = gam();

    g.streakDays = 7;
    g.awardBadges(all, { payoutEnabled: false });  // earned during the pause

    g.streakDays = 30;
    g.awardBadges(all, { payoutEnabled: true });   // earned after enabling

    expect(g.isBadgePayoutEligible('streak_7')).toBe(false);
    expect(g.isBadgePayoutEligible('streak_30')).toBe(true);
  });

  it('treats every pre-existing badge row as unpayable without a migration', () => {
    // Rows written before this field existed have no value for it. The schema
    // default closes the entire historical backlog on its own — which is why
    // there is no backfill script to run or get wrong.
    const g = gam([{ key: 'streak_7', unlocked: true, unlockedAt: new Date() }]);
    expect(g.isBadgeUnlocked('streak_7')).toBe(true);
    expect(g.isBadgePayoutEligible('streak_7')).toBe(false);
  });

  it('defaults to not payable when the caller forgets to pass the flag', () => {
    // Fail closed: a missed option must not silently create a coin liability.
    const g = gam();
    g.streakDays = 30;
    g.awardBadges(defs);
    expect(g.isBadgePayoutEligible('streak_30')).toBe(false);
  });
});
