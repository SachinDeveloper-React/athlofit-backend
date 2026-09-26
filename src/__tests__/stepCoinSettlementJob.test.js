// Tests for the settlement job: moving pending step coins into the balance.
//
// The policy is tested in stepCoinSettlement.test.js. What matters here is the
// money: each award leaves `pending` exactly once, the balance moves by exactly
// what was paid, the ledger says so under the award's own source, and a run
// that loses the race for an award pays nothing for it.

const mockState = {
  entries: [],
  rows: [],
  balance: 0,
  gam: null, // streak fields, when a test cares about them
  badgeDefs: [],
  ledger: [],
  notifications: [],
  stolen: new Set(), // entry ids another run claims first
};

jest.mock('../models/PendingCoin.model', () => ({
  find: (filter) => ({
    sort: () => ({
      lean: async () =>
        mockState.entries.filter(
          (e) => e.status === 'pending' && e.date === filter.date && e.user === filter.user,
        ),
    }),
  }),
  findOneAndUpdate: async (filter, update) => {
    const e = mockState.entries.find((x) => x._id === filter._id);
    if (!e || e.status !== 'pending' || mockState.stolen.has(e._id)) return null;
    Object.assign(e, update.$set);
    return e;
  },
  updateOne: async (filter, update) => {
    const e = mockState.entries.find((x) => x._id === filter._id);
    if (e) Object.assign(e, update.$set);
  },
  aggregate: async ([match]) => {
    const today = match.$match.date.$lt;
    const seen = new Map();
    for (const e of mockState.entries) {
      if (e.status !== 'pending' || e.date >= today) continue;
      seen.set(`${e.user}|${e.date}`, { _id: { user: e.user, date: e.date } });
    }
    return [...seen.values()];
  },
}));

jest.mock('../models/HealthActivity.model', () => ({
  find: (filter) => ({
    select: () => ({
      lean: async () =>
        mockState.rows.filter(
          (r) =>
            r.user === filter.user &&
            (filter.date ? filter.date.$in.includes(r.date) : true) &&
            (filter.goalMet === undefined || r.goalMet === filter.goalMet),
        ),
    }),
  }),
  findOneAndUpdate: async (filter, update) => {
    const row = mockState.rows.find(
      (r) => r.user === filter.user && r.date === filter.date && r.steps > filter.steps.$gt,
    );
    if (!row) return null;
    const before = { ...row };
    Object.assign(row, update.$set);
    return before;
  },
}));

jest.mock('../models/Gamification.model', () => ({
  findOneAndUpdate: async (filter, update) => {
    mockState.balance += update.$inc.coinsBalance;
    return { coinsBalance: mockState.balance };
  },
  findOne: () => ({ lean: async () => (mockState.gam ? { ...mockState.gam } : null) }),
  updateOne: async (filter, update) => {
    const g = mockState.gam;
    if (!g || g.streakDays !== filter.streakDays || g.lastActiveDate !== filter.lastActiveDate) {
      return { matchedCount: 0 };
    }
    Object.assign(g, update.$set);
    return { matchedCount: 1 };
  },
}));

jest.mock('../models/BadgeDefinition.model', () => ({
  find: () => ({ select: () => ({ lean: async () => mockState.badgeDefs }) }),
}));

jest.mock('../utils/logCoinTransaction', () => ({
  logCoinTransaction: async (tx) => {
    mockState.ledger.push(tx);
  },
}));

jest.mock('../utils/createNotification', () => ({
  createNotification: (userId, n) => {
    mockState.notifications.push(n);
  },
}));

const { settleStepCoins } = require('../crons/stepCoinSettlement');

const USER = 'u1';

/** A row on which one stream was held for three hours at ~150 steps/min. */
function machineRow(date) {
  const T0 = new Date(`${date}T02:30:00Z`).getTime();
  const min = (n) => n * 60_000;
  // Two ordinary opening windows, then a flat band the live rule refused.
  const samples = [
    { delta: 1_526, rate: 56.9, from: T0 - min(27), at: T0, stuck: false, total: 1_559 },
    ...Array.from({ length: 18 }, (_, i) => ({
      delta: 2_250 + (i % 3) * 10,
      rate: 150 + (i % 3) * 0.6,
      from: T0 + min(i * 15),
      at: T0 + min(i * 15 + 15),
      stuck: i >= 6,
      total: 1_559 + (i + 1) * 2_260,
    })),
  ];
  return {
    user: USER,
    date,
    steps: 15_000,
    bonusSteps: 0,
    stepBaseline: 15_000,
    distance: 30,
    calories: 1_500,
    activeMinutes: 300,
    lastIncomingSteps: samples.at(-1).total,
    cadenceBySource: { worker: { samples } },
  };
}

const entry = (id, date, source, amount, metadata) => ({
  _id: id,
  user: USER,
  date,
  source,
  amount,
  description: `${source} test award`,
  metadata,
  status: 'pending',
});

beforeEach(() => {
  mockState.entries = [];
  mockState.rows = [];
  mockState.gam = null;
  mockState.badgeDefs = [];
  mockState.balance = 100;
  mockState.ledger = [];
  mockState.notifications = [];
  mockState.stolen = new Set();
});

describe('settleStepCoins', () => {
  it('pays an honest day in full, under each award’s own source', async () => {
    mockState.rows = [{ user: USER, date: '2026-09-22', steps: 11_000, bonusSteps: 0 }];
    mockState.entries = [
      entry('p1', '2026-09-22', 'PASSIVE_STEPS', 55, { previousSteps: 0, steps: 11_000 }),
      entry('g1', '2026-09-22', 'DAILY_STEP_GOAL_AUTO', 50, { goal: 10_000 }),
    ];

    const totals = await settleStepCoins({ today: '2026-09-23' });

    expect(totals).toMatchObject({ days: 1, entries: 2, paidCoins: 105, refusedCoins: 0 });
    expect(mockState.balance).toBe(205);
    expect(mockState.entries.every((e) => e.status === 'settled')).toBe(true);
    expect(mockState.ledger.map((t) => t.source)).toEqual(['PASSIVE_STEPS', 'DAILY_STEP_GOAL_AUTO']);
    expect(mockState.ledger.every((t) => t.metadata.trigger === 'settlement')).toBe(true);
    expect(mockState.notifications).toHaveLength(1);
    expect(mockState.notifications[0].message).toMatch(/105 coins for your steps on 22 Sep/);
  });

  it('pays only what arrived before the machine started, and says why', async () => {
    mockState.rows = [machineRow('2026-09-22')];
    mockState.entries = [
      entry('p1', '2026-09-22', 'PASSIVE_STEPS', 7.5, { previousSteps: 0, steps: 1_559 }),
      entry('p2', '2026-09-22', 'PASSIVE_STEPS', 67.2, { previousSteps: 1_559, steps: 15_000 }),
      entry('g1', '2026-09-22', 'DAILY_STEP_GOAL_AUTO', 50, { goal: 10_000 }),
      entry('c1', '2026-09-22', 'CHALLENGE', 30, {
        criteriaType: 'STEPS', targetValue: 5_000, challengeType: 'daily',
      }),
    ];

    const totals = await settleStepCoins({ today: '2026-09-23' });

    const byId = Object.fromEntries(mockState.entries.map((e) => [e._id, e]));
    expect(byId.p1).toMatchObject({ status: 'settled', settledAmount: 7.5, reason: null });
    expect(byId.p2.status).toBe('refused');
    expect(byId.g1.status).toBe('refused');
    expect(byId.c1.status).toBe('refused');
    expect(byId.g1.reason).toMatch(/machine-like/);

    expect(totals.paidCoins).toBe(7.5);
    expect(totals.refusedCoins).toBeCloseTo(67.2 + 50 + 30, 4);
    expect(mockState.balance).toBe(107.5);
    expect(mockState.ledger).toHaveLength(1);
    expect(mockState.notifications[0].message).toMatch(/could not be verified/);
    expect(mockState.notifications[0].message).toMatch(/Contact support/);
  });

  it('leaves today alone', async () => {
    mockState.rows = [{ user: USER, date: '2026-09-23', steps: 11_000, bonusSteps: 0 }];
    mockState.entries = [
      entry('p1', '2026-09-23', 'PASSIVE_STEPS', 55, { previousSteps: 0, steps: 11_000 }),
    ];

    const totals = await settleStepCoins({ today: '2026-09-23' });

    expect(totals.days).toBe(0);
    expect(mockState.entries[0].status).toBe('pending');
    expect(mockState.balance).toBe(100);
  });

  it('pays nothing twice, run after run', async () => {
    mockState.rows = [{ user: USER, date: '2026-09-22', steps: 11_000, bonusSteps: 0 }];
    mockState.entries = [
      entry('p1', '2026-09-22', 'PASSIVE_STEPS', 55, { previousSteps: 0, steps: 11_000 }),
    ];

    await settleStepCoins({ today: '2026-09-23' });
    await settleStepCoins({ today: '2026-09-23' });

    expect(mockState.balance).toBe(155);
    expect(mockState.ledger).toHaveLength(1);
  });

  it('pays nothing for an award another run claimed first', async () => {
    mockState.rows = [{ user: USER, date: '2026-09-22', steps: 11_000, bonusSteps: 0 }];
    mockState.entries = [
      entry('p1', '2026-09-22', 'PASSIVE_STEPS', 55, { previousSteps: 0, steps: 11_000 }),
      entry('g1', '2026-09-22', 'DAILY_STEP_GOAL_AUTO', 50, { goal: 10_000 }),
    ];
    mockState.stolen.add('g1');

    const totals = await settleStepCoins({ today: '2026-09-23' });

    expect(totals.paidCoins).toBe(55);
    expect(mockState.balance).toBe(155);
    expect(mockState.ledger.map((t) => t.source)).toEqual(['PASSIVE_STEPS']);
  });

  it('judges a weekly challenge on every day of its week', async () => {
    mockState.rows = [
      { user: USER, date: '2026-09-20', steps: 12_000, bonusSteps: 0 },
      { user: USER, date: '2026-09-21', steps: 12_000, bonusSteps: 0 },
      machineRow('2026-09-22'),
    ];
    mockState.entries = [
      entry('w1', '2026-09-22', 'CHALLENGE', 200, {
        criteriaType: 'STEPS',
        targetValue: 30_000,
        challengeType: 'weekly',
        weekStart: '2026-09-20',
      }),
    ];

    await settleStepCoins({ today: '2026-09-23' });

    // Live: 12,000 + 12,000 + 15,000 = 39,000. Verified: 24,000 + 1,559.
    expect(mockState.entries[0].status).toBe('refused');
    expect(mockState.balance).toBe(100);
  });

  it('brings the day down to what was verified, and closes it', async () => {
    const row = { ...machineRow('2026-09-22'), goalMet: true, goalSnapshot: 10_000 };
    mockState.rows = [row];
    mockState.entries = [
      entry('p1', '2026-09-22', 'PASSIVE_STEPS', 7.5, { previousSteps: 0, steps: 1_559 }),
    ];

    await settleStepCoins({ today: '2026-09-23' });

    expect(row).toMatchObject({ steps: 1_559, goalMet: false, stuckClosed: true });
    expect(row.stepVerification).toMatchObject({
      status: 'partial',
      walkedBefore: 15_000,
      payableWalked: 1_559,
      goalMetBefore: true,
    });
    // Scaled by the payable share of the raw count — 1,559 of the 42,239 the
    // phone reported — not left at full size.
    const share = 1_559 / 42_239;
    expect(row.distance).toBeCloseTo(30 * share, 2);
    expect(row.calories).toBe(Math.round(1_500 * share));
    expect(row.activeMinutes).toBe(Math.round(300 * share));

    // A second run over the same day changes nothing further.
    const snapshot = { ...row };
    mockState.entries.push(
      entry('p2', '2026-09-22', 'PASSIVE_STEPS', 1, { previousSteps: 1_559, steps: 1_700 }),
    );
    await settleStepCoins({ today: '2026-09-23' });
    expect(row.steps).toBe(snapshot.steps);
    expect(row.stepVerification.at).toBe(snapshot.stepVerification.at);
  });

  it('takes a day whose goal no longer holds back out of the streak', async () => {
    mockState.rows = [
      { user: USER, date: '2026-09-19', steps: 11_000, bonusSteps: 0, goalMet: true },
      { user: USER, date: '2026-09-20', steps: 11_000, bonusSteps: 0, goalMet: true },
      { user: USER, date: '2026-09-21', steps: 11_000, bonusSteps: 0, goalMet: true },
      { ...machineRow('2026-09-22'), goalMet: true, goalSnapshot: 10_000 },
      { user: USER, date: '2026-09-23', steps: 12_000, bonusSteps: 0, goalMet: true },
    ];
    // The streak counted all five days; the 7-day badge is not reached, the
    // 3-day one is, and unclaimed.
    mockState.gam = {
      streakDays: 5,
      bestStreakDays: 5,
      lastActiveDate: '2026-09-23',
      lastFreezeGrantStreak: 0,
      badgeList: [{ key: 'starter', unlocked: true, coinsClaimed: false }],
    };
    mockState.badgeDefs = [{ key: 'starter', threshold: 3 }, { key: 'week', threshold: 7 }];
    mockState.entries = [
      entry('g1', '2026-09-22', 'DAILY_STEP_GOAL_AUTO', 50, { goal: 10_000 }),
    ];

    const totals = await settleStepCoins({ today: '2026-09-23' });

    // Only 23 Sep is left after the withdrawn day; the run before it — three
    // real days — is still the best on record, so the badge it earned stays.
    expect(mockState.gam).toMatchObject({ streakDays: 1, bestStreakDays: 3 });
    expect(mockState.gam.badgeList[0].unlocked).toBe(true);
    expect(mockState.notifications[0].message).toMatch(/no longer counts toward your streak/);
    expect(totals.refusedCoins).toBe(50);
  });

  it('leaves the streak alone when the verified steps still meet the goal', async () => {
    const row = { ...machineRow('2026-09-22'), goalMet: true, goalSnapshot: 1_000 };
    mockState.rows = [row];
    mockState.gam = { streakDays: 4, bestStreakDays: 4, lastActiveDate: '2026-09-22', badgeList: [] };
    mockState.entries = [
      entry('g1', '2026-09-22', 'DAILY_STEP_GOAL_AUTO', 50, { goal: 1_000 }),
    ];

    await settleStepCoins({ today: '2026-09-23' });

    expect(row.goalMet).toBe(true);
    expect(mockState.gam.streakDays).toBe(4);
  });
});
