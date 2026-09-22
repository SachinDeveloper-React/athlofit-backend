// Tests for the shared-counter rule — one phone's step counter feeding two
// accounts. See the note at the top of utils/sharedStepSource.js.

const {
  resolveSharedSource,
  countSharedSamples,
  isNewerAccount,
  accountCreatedMs,
  SHARED_MIN_STEPS,
  SHARED_MATCH_WINDOW_MIN,
  SHARED_MIN_MATCHES,
} = require('../utils/sharedStepSource');
const { validateSteps } = require('../utils/stepValidation');
const { resolveLogReason } = require('../utils/syncLog');

// The two real accounts. Same phone (a Xiaomi 23049PCD8I), two installIds,
// created five hours apart on 10 Aug.
const OLDER = '6a79bede207e8236e685d50b';
const NEWER = '6a7a068c207e8236e685fafc';

const base = {
  bonusSteps: 0,
  dailyGoal: 10000,
  timezone: 'Asia/Kolkata',
};

beforeAll(() => {
  jest.useFakeTimers({ now: new Date('2026-09-21T06:30:00.000Z') });
});
afterAll(() => {
  jest.useRealTimers();
});

describe('isNewerAccount', () => {
  it('reads the creation time out of the ObjectId', () => {
    expect(new Date(accountCreatedMs(OLDER)).toISOString()).toBe('2026-08-10T12:06:54.000Z');
    expect(new Date(accountCreatedMs(NEWER)).toISOString()).toBe('2026-08-10T17:12:44.000Z');
    expect(isNewerAccount(NEWER, OLDER)).toBe(true);
    expect(isNewerAccount(OLDER, NEWER)).toBe(false);
  });

  it('is total: two accounts created in the same second still order', () => {
    const a = '6a79bede000000000000000a';
    const b = '6a79bede000000000000000b';
    expect(isNewerAccount(a, b)).not.toBe(isNewerAccount(b, a));
  });

  it('falls back to string order for something that is not an ObjectId', () => {
    expect(isNewerAccount('zzz', 'aaa')).toBe(true);
  });
});

describe('countSharedSamples', () => {
  const T = (iso) => new Date(iso).getTime();

  it('counts the same total arriving at the same moment', () => {
    const mine = [
      { total: 2_560, at: T('2026-09-21T02:44:57.676Z') },
      { total: 4_800, at: T('2026-09-21T03:00:01.024Z') },
    ];
    const theirs = [
      { total: 2_560, at: T('2026-09-21T02:44:57.679Z') },
      { total: 4_800, at: T('2026-09-21T03:00:01.017Z') },
    ];
    expect(countSharedSamples(mine, theirs)).toBe(2);
  });

  it('does not count the same total hours apart', () => {
    // Two real people can both reach 2,560 in a day. They do not do it at
    // the same minute.
    const mine = [{ total: 2_560, at: T('2026-09-21T02:44:57Z') }];
    const theirs = [{ total: 2_560, at: T('2026-09-21T09:12:00Z') }];
    expect(countSharedSamples(mine, theirs)).toBe(0);
  });

  it('allows the window, and no more', () => {
    const at = T('2026-09-21T02:44:57Z');
    const inside = at + SHARED_MATCH_WINDOW_MIN * 60_000;
    const outside = inside + 1;
    expect(countSharedSamples([{ total: 2_560, at }], [{ total: 2_560, at: inside }])).toBe(1);
    expect(countSharedSamples([{ total: 2_560, at }], [{ total: 2_560, at: outside }])).toBe(0);
  });

  it('ignores totals too small to be evidence', () => {
    const at = T('2026-09-21T02:14:53Z');
    const small = SHARED_MIN_STEPS - 1;
    expect(countSharedSamples([{ total: small, at }], [{ total: small, at }])).toBe(0);
    expect(countSharedSamples([{ total: SHARED_MIN_STEPS, at }], [{ total: SHARED_MIN_STEPS, at }])).toBe(1);
  });

  it('spends each of theirs once, so a re-send is not two matches', () => {
    const at = T('2026-09-21T02:44:57Z');
    const mine = [
      { total: 2_560, at },
      { total: 2_560, at: at + 20_000 }, // the service re-posting a figure it never saw acknowledged
    ];
    const theirs = [{ total: 2_560, at }];
    expect(countSharedSamples(mine, theirs)).toBe(1);
  });
});

describe('resolveSharedSource', () => {
  const T = (iso) => new Date(iso).getTime();

  it('holds the newer account and names the older', () => {
    const at = T('2026-09-21T03:00:01Z');
    const mine = [
      { total: 2_560, at: at - 15 * 60_000 },
      { total: 4_800, at },
    ];
    const candidates = [
      { user: OLDER, sampleTotals: [
        { total: 2_560, at: at - 15 * 60_000 + 3 },
        { total: 4_800, at: at - 7 },
      ] },
    ];
    const r = resolveSharedSource({ userId: NEWER, mine, candidates });
    expect(r).toMatchObject({ shared: true, held: true, otherUser: OLDER, matches: 2 });
    expect(r.reason).toContain(OLDER);
    expect(r.reason).toMatch(/held for the day/);
  });

  it('lets the older account keep the steps, but records the finding', () => {
    const at = T('2026-09-21T03:00:01Z');
    const mine = [
      { total: 2_560, at: at - 15 * 60_000 },
      { total: 4_800, at },
    ];
    const candidates = [
      { user: NEWER, sampleTotals: [
        { total: 2_560, at: at - 15 * 60_000 - 3 },
        { total: 4_800, at: at + 7 },
      ] },
    ];
    const r = resolveSharedSource({ userId: OLDER, mine, candidates });
    expect(r).toMatchObject({ shared: true, held: false, otherUser: NEWER, matches: 2 });
    expect(r.reason).toMatch(/keeps the steps/);
  });

  it('needs SHARED_MIN_MATCHES — one coincidence is a coincidence', () => {
    const at = T('2026-09-21T08:31:00Z');
    const r = resolveSharedSource({
      userId: NEWER,
      mine: [{ total: 1_200, at }],
      candidates: [{ user: OLDER, sampleTotals: [{ total: 1_200, at: at + 40_000 }] }],
    });
    expect(SHARED_MIN_MATCHES).toBe(2);
    expect(r.shared).toBe(false);
    expect(r.held).toBe(false);
  });

  it('is not fooled by its own row', () => {
    const at = T('2026-09-21T03:00:01Z');
    const mine = [{ total: 2_560, at: at - 15 * 60_000 }, { total: 4_800, at }];
    const r = resolveSharedSource({
      userId: NEWER,
      mine,
      candidates: [{ user: NEWER, sampleTotals: mine }],
    });
    expect(r.shared).toBe(false);
  });

  it('picks the account with the most matches when several qualify', () => {
    const at = T('2026-09-21T03:00:01Z');
    const step = (k) => ({ total: 2_000 + k * 1_000, at: at + k * 15 * 60_000 });
    const mine = [step(0), step(1), step(2), step(3)];
    const r = resolveSharedSource({
      userId: NEWER,
      mine,
      candidates: [
        { user: '6a79bede0000000000000001', sampleTotals: [step(0), step(1)] },
        { user: '6a79bede0000000000000002', sampleTotals: [step(0), step(1), step(2), step(3)] },
      ],
    });
    expect(String(r.otherUser)).toBe('6a79bede0000000000000002');
    expect(r.matches).toBe(4);
  });
});

describe('the 21 Sep pair, replayed', () => {
  // Both accounts' foreground-service samples for the day — every gain of at
  // least 500 steps, with the raw total and the instant it arrived at the
  // server. Taken from the two provenance ledgers. [total, older's at, newer's at]
  const PAIR = [
    [2_560,  '02:44:57.676Z', '02:44:57.679Z'],
    [4_800,  '03:00:01.024Z', '03:00:01.017Z'],
    [7_050,  '03:15:05.523Z', '03:15:05.508Z'],
    [9_310,  '03:30:09.422Z', '03:30:09.405Z'],
    [11_570, '03:45:12.371Z', '03:45:12.403Z'],
    [13_830, '04:00:16.310Z', '04:00:15.891Z'],
    [14_848, '04:15:19.558Z', '04:15:19.570Z'],
    [16_396, '04:46:34.414Z', '04:46:34.417Z'],
    [17_738, '05:01:37.338Z', '05:01:37.331Z'],
    [19_998, '05:16:38.556Z', '05:16:38.560Z'],
    [20_823, '05:31:41.471Z', '05:31:41.541Z'],
    [23_748, '12:32:30.103Z', '12:32:30.124Z'],
    [24_759, '12:47:33.974Z', '12:47:33.980Z'],
    [27_019, '13:02:35.740Z', '13:02:35.744Z'],
    [29_279, '13:17:38.584Z', '13:17:38.579Z'],
  ];
  const T = (hms) => new Date(`2026-09-21T${hms}`).getTime();

  /**
   * Runs both accounts' syncs in arrival order. Each sync sees the other row
   * only as it had been COMMITTED by then: a post that landed within a tenth
   * of a second is still in flight, which is the race the rule is built
   * around.
   */
  const replay = () => {
    const events = [];
    for (const [total, olderAt, newerAt] of PAIR) {
      events.push({ user: OLDER, total, at: T(olderAt) });
      events.push({ user: NEWER, total, at: T(newerAt) });
    }
    events.sort((a, b) => a.at - b.at);

    const rows = { [OLDER]: [], [NEWER]: [] };
    const out = [];
    for (const e of events) {
      const other = e.user === OLDER ? NEWER : OLDER;
      const committed = rows[other].filter((s) => s.at < e.at - 100);
      const mine = [...rows[e.user], { total: e.total, at: e.at }];
      const verdict = resolveSharedSource({
        userId: e.user,
        mine,
        candidates: [{ user: other, sampleTotals: committed }],
      });
      out.push({ ...e, ...verdict });
      rows[e.user].push({ total: e.total, at: e.at });
    }
    return out;
  };

  it('neither account can see the other on the tick they post together', () => {
    // The first shared total: both requests in flight, neither committed.
    const first = replay().filter((s) => s.total === 2_560);
    expect(first.every((s) => !s.shared)).toBe(true);
  });

  it('the newer account is held from its third sample, on the two before it', () => {
    const newer = replay().filter((s) => s.user === NEWER);
    expect(newer.map((s) => s.held)).toEqual([
      false, // 2,560 — nothing committed on the other side yet
      false, // 4,800 — one match (the 2,560 from fifteen minutes ago)
      ...Array(PAIR.length - 2).fill(true), // 7,050 onward
    ]);
    expect(newer[2].reason).toContain(OLDER);
  });

  it('the older account is never held, and knows who the other is', () => {
    const older = replay().filter((s) => s.user === OLDER);
    expect(older.some((s) => s.held)).toBe(false);
    const aware = older.filter((s) => s.shared);
    expect(aware.length).toBeGreaterThan(0);
    expect(aware.every((s) => String(s.otherUser) === NEWER)).toBe(true);
  });

  it('the match count grows with the day, so the evidence is on the row', () => {
    const last = replay().filter((s) => s.user === NEWER).at(-1);
    expect(last.matches).toBeGreaterThanOrEqual(PAIR.length - 2);
  });
});

describe('validateSteps under a shared source', () => {
  const heldVerdict = {
    shared: true,
    held: true,
    otherUser: OLDER,
    matches: 3,
    reason: `Step counter shared with account ${OLDER}: the same totals arrived from both`,
  };

  it('holds the stored total exactly where it is', () => {
    const r = validateSteps({
      ...base,
      incomingSteps: 7_050,
      existingSteps: 4_800,
      sharedSource: heldVerdict,
    });
    expect(r.clampedSteps).toBe(4_800);
    expect(r.flagged).toBe(true);
    expect(r.severity).toBe('shared_source');
    expect(r.reason).toContain(OLDER);
  });

  it('does not touch the older account', () => {
    const r = validateSteps({
      ...base,
      incomingSteps: 7_050,
      existingSteps: 4_800,
      sharedSource: { ...heldVerdict, held: false, otherUser: NEWER },
    });
    expect(r.clampedSteps).toBe(7_050);
    expect(r.severity).toBe('none');
  });

  it('is a no-op for callers that pass nothing', () => {
    const r = validateSteps({ ...base, incomingSteps: 7_050, existingSteps: 4_800 });
    expect(r.clampedSteps).toBe(7_050);
    expect(r.severity).toBe('none');
  });

  it('reports the shared source, not the stuck one, when both hold', () => {
    // The same phone in a shaker on two accounts trips both rules at once. The
    // reason that names the other account is the one an investigation needs.
    const r = validateSteps({
      ...base,
      incomingSteps: 7_050,
      existingSteps: 4_800,
      sharedSource: heldVerdict,
      cadence: { stuck: true, stuckReason: '+2260 steps reported 4 times today' },
    });
    expect(r.clampedSteps).toBe(4_800);
    expect(r.severity).toBe('shared_source');
    expect(r.reason).toContain(OLDER);
  });
});

describe('the sync log keeps every shared-source sync', () => {
  it('names it ahead of the generic reasons', () => {
    expect(
      resolveLogReason({
        tracing: false,
        rejected: false,
        severity: 'shared_source',
        flagged: true,
        corrected: false,
        incomingSteps: 7_050,
        clampedSteps: 4_800,
        existingSteps: 4_800,
      }),
    ).toBe('shared_source');
  });
});

describe('the 12 Sep pair — one counter, six steps apart', () => {
  // The same two accounts, nine days earlier. Syncs in the same second all
  // day; totals a constant 6 apart, because the two copies re-baselined at
  // midnight seconds apart. Exact matching found nothing.
  const { sharedSampleMatches, SHARED_OFFSET_MIN_MATCHES, SHARED_OFFSET_MAX } =
    require('../utils/sharedStepSource');
  const T = (hms) => new Date(`2026-09-12T${hms}`).getTime();
  const older = [
    { total: 1_547, at: T('03:06:39Z') },
    { total: 3_807, at: T('03:21:41Z') },
    { total: 6_057, at: T('03:36:42Z') },
    { total: 8_307, at: T('03:51:44Z') },
    { total: 10_557, at: T('04:06:46Z') },
  ];
  const newer = older.map((s) => ({ total: s.total - 6, at: s.at + 20 }));

  it('sees the constant offset as one counter', () => {
    expect(sharedSampleMatches(newer, older)).toEqual({ matches: 5, offset: -6 });
  });

  it('needs one match more at an offset than at equality', () => {
    expect(SHARED_OFFSET_MIN_MATCHES).toBe(3);
    const two = resolveSharedSource({
      userId: NEWER,
      mine: newer.slice(0, 2),
      candidates: [{ user: OLDER, sampleTotals: older }],
    });
    expect(two.shared).toBe(false);
    const three = resolveSharedSource({
      userId: NEWER,
      mine: newer.slice(0, 3),
      candidates: [{ user: OLDER, sampleTotals: older }],
    });
    expect(three).toMatchObject({ shared: true, held: true, offset: -6, matches: 3 });
    expect(three.reason).toMatch(/6 steps apart/);
  });

  it('does not chain a drifting difference into a match', () => {
    // Two honest walkers near each other in total: the gap changes every window.
    const drifting = older.map((s, i) => ({ total: s.total - 6 - i * 37, at: s.at + 20 }));
    expect(sharedSampleMatches(drifting, older).matches).toBe(1);
  });

  it('ignores a difference larger than a baseline could produce', () => {
    const far = older.map((s) => ({ total: s.total - SHARED_OFFSET_MAX - 1, at: s.at + 20 }));
    expect(sharedSampleMatches(far, older).matches).toBe(0);
  });

  it('prefers offset zero on a tie', () => {
    const mixed = [...older.slice(0, 2), ...newer.slice(2, 4)];
    const r = sharedSampleMatches(mixed, older);
    expect(r.matches).toBe(2);
    expect(r.offset).toBe(0);
  });
});
