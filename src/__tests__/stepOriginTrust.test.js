// Tests for the origin-trust rule and the history read behind it.
//
// The rule decides one thing only: may this day count as evidence of what the
// account walks. So the tests that matter most are the ones that pin it against
// the real incident data — the ten honest accounts must come out trusted and the
// three fraudulent ones must not, because getting that backwards is how a
// blocklist would have zeroed a user who logs 438 steps a day.

jest.mock('../models/StepProvenance.model', () => ({ find: jest.fn() }));

const StepProvenance = require('../models/StepProvenance.model');
const {
  resolveOriginTrust,
  ORIGIN_TRUST_MIN_DAYS,
  ORIGIN_CHURN_MAX,
  ORIGIN_WINDOW_DAYS,
} = require('../utils/stepOriginTrust');
const { loadOriginHistory } = require('../utils/stepOriginTrustStore');
const { shiftDate } = require('../utils/stepBaselineStore');

/** History in which every named origin has been seen on enough days to establish. */
const established = (...origins) => ({
  establishedOrigins: origins,
  distinctPrimaries: origins.length,
});

const PLATFORM = 'com.android.healthconnect.phone.j72a0b5170cde33b8b9f7f5d4c07c5f9a';
const FIT = 'com.google.android.apps.fitness';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveOriginTrust — readers that carry no origin claim', () => {
  it('trusts the hardware sensor, which has no per-app breakdown to give', () => {
    // A sensor-only phone — no Health Connect at all — is a large share of the
    // install base. Withholding trust here would leave every one of them unable
    // to ever build a baseline, so they would sit on the floor permanently.
    const result = resolveOriginTrust({
      reader: 'native_sensor',
      primaryOrigin: null,
      history: { originDays: {}, distinctPrimaries: 0 },
    });
    expect(result.trusted).toBe(true);
  });

  it('trusts a build too old to report its step source', () => {
    const result = resolveOriginTrust({
      reader: null,
      primaryOrigin: null,
      history: { originDays: {}, distinctPrimaries: 0 },
    });
    expect(result.trusted).toBe(true);
  });

  it('does not trust Health Connect naming nobody', () => {
    // Unlike the sensor, this reader is expected to say where its figure came
    // from — silence is a gap in the evidence, not a source that has none.
    const result = resolveOriginTrust({
      reader: 'health_connect',
      primaryOrigin: null,
      history: established(PLATFORM),
    });
    expect(result.trusted).toBe(false);
  });
});

describe('resolveOriginTrust — an origin has to earn it', () => {
  it('trusts a source the account has been using', () => {
    const result = resolveOriginTrust({
      reader: 'health_connect',
      primaryOrigin: PLATFORM,
      history: established(PLATFORM),
    });
    expect(result.trusted).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('does not trust a source that appeared today', () => {
    const result = resolveOriginTrust({
      reader: 'health_connect',
      primaryOrigin: 'com.android.healthconnect.phone.jbrandnew',
      history: established(PLATFORM),
    });
    expect(result.trusted).toBe(false);
    expect(result.reason).toMatch(/new to this account/);
  });

  it('does not trust a source that has only lasted a day or two', () => {
    // What a reinstalled spoofer looks like. The threshold is what stops one
    // from establishing before it rotates again.
    const result = resolveOriginTrust({
      reader: 'health_connect',
      primaryOrigin: PLATFORM,
      // Seen, but not yet on enough days — so not in the established set.
      history: { establishedOrigins: [], distinctPrimaries: 1 },
    });
    expect(result.trusted).toBe(false);
  });

  it('judges each origin on its own history, not on the account having some', () => {
    // An account with one long-standing source does not thereby vouch for a
    // second one that turned up this morning.
    const result = resolveOriginTrust({
      reader: 'health_connect',
      primaryOrigin: FIT,
      history: { establishedOrigins: [PLATFORM], distinctPrimaries: 2 },
    });
    expect(result.trusted).toBe(false);
  });
});

describe('resolveOriginTrust — churn overrides everything', () => {
  it('trusts nothing once the account is cycling through sources', () => {
    // The backstop for a rotation slow enough that individual origins would each
    // establish on their own. From inside such a rotation, "this one has lasted
    // three days" is not evidence of anything.
    const churning = {
      establishedOrigins: Array.from(
        { length: ORIGIN_CHURN_MAX + 1 },
        (_, i) => `pkg.${i}`,
      ),
      distinctPrimaries: ORIGIN_CHURN_MAX + 1,
    };
    const result = resolveOriginTrust({
      reader: 'health_connect',
      primaryOrigin: 'pkg.0',
      history: churning,
    });
    expect(result.trusted).toBe(false);
    expect(result.reason).toMatch(/different primary step sources/);
  });

  it('leaves room for a phone with a pedometer, a fitness app and one switch', () => {
    const ordinary = {
      establishedOrigins: [PLATFORM, FIT, 'com.sec.android.app.shealth'],
      distinctPrimaries: 3,
    };
    const result = resolveOriginTrust({
      reader: 'health_connect',
      primaryOrigin: PLATFORM,
      history: ordinary,
    });
    expect(result.trusted).toBe(true);
  });
});

describe('resolveOriginTrust — against the accounts from the incident', () => {
  // Distinct origins per account, from the provenance ledger. The ten honest
  // accounts each had exactly one, stable for as long as they had data. The
  // three fraudulent ones rotated.
  const HONEST_ORIGIN_COUNTS = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const FRAUDULENT_ORIGIN_COUNTS = [9, 8, 4];

  it('trusts every one of the ten honest accounts', () => {
    for (const count of HONEST_ORIGIN_COUNTS) {
      const result = resolveOriginTrust({
        reader: 'health_connect',
        primaryOrigin: PLATFORM,
        history: { establishedOrigins: [PLATFORM], distinctPrimaries: count },
      });
      expect(result.trusted).toBe(true);
    }
  });

  it('trusts none of the three fraudulent accounts', () => {
    for (const count of FRAUDULENT_ORIGIN_COUNTS) {
      const result = resolveOriginTrust({
        reader: 'health_connect',
        primaryOrigin: PLATFORM,
        // Generous on purpose: even granting that the origin being used today has
        // a long history, the rotation alone must be enough to refuse it.
        history: { establishedOrigins: [PLATFORM], distinctPrimaries: count },
      });
      expect(result.trusted).toBe(false);
    }
  });

  it('never decides on the package name', () => {
    // The one pattern that looked like a signature was mostly honest users. Two
    // accounts with identical histories and different-looking package names must
    // come out the same.
    const withOrigin = origin =>
      resolveOriginTrust({
        reader: 'health_connect',
        primaryOrigin: origin,
        history: { establishedOrigins: [origin], distinctPrimaries: 1 },
      }).trusted;

    expect(withOrigin(PLATFORM)).toBe(true);
    expect(withOrigin(FIT)).toBe(true);
    expect(withOrigin('com.android.healthconnect.phone.jdeadbeef')).toBe(true);
  });
});

describe('loadOriginHistory', () => {
  const mockRows = rows => {
    StepProvenance.find.mockReturnValue({ lean: () => Promise.resolve(rows) });
  };

  it('reads the trailing window and excludes the day being validated', async () => {
    // An origin that could vouch for itself within the day would make the rule a
    // formality: post once to register, then post the payload.
    mockRows([]);
    await loadOriginHistory({ userId: 'u1', date: '2026-09-04' });

    const [filter] = StepProvenance.find.mock.calls[0];
    expect(filter.user).toBe('u1');
    expect(filter.date.$lt).toBe('2026-09-04');
    expect(filter.date.$gte).toBe(shiftDate('2026-09-04', ORIGIN_WINDOW_DAYS));
  });

  it('counts distinct DAYS, not entries', async () => {
    // The widget worker posts every 15 minutes, so one day yields up to ninety
    // entries naming the same origin. Counting entries would let a single day
    // establish an origin outright.
    mockRows([
      { date: '2026-09-01', entries: Array.from({ length: 90 }, () => ({ primaryOrigin: PLATFORM })) },
    ]);

    const history = await loadOriginHistory({ userId: 'u1', date: '2026-09-04' });
    // One day is not three, so ninety entries establish nothing.
    expect(history.establishedOrigins).toEqual([]);
    expect(history.distinctPrimaries).toBe(1);
  });

  it('accumulates an origin across the days it appeared on', async () => {
    mockRows([
      { date: '2026-09-01', entries: [{ primaryOrigin: PLATFORM }, { primaryOrigin: PLATFORM }] },
      { date: '2026-09-02', entries: [{ primaryOrigin: PLATFORM }] },
      { date: '2026-09-03', entries: [{ primaryOrigin: PLATFORM }, { primaryOrigin: FIT }] },
    ]);

    const history = await loadOriginHistory({ userId: 'u1', date: '2026-09-04' });
    // PLATFORM on three days establishes; FIT on one does not.
    expect(history.establishedOrigins).toEqual([PLATFORM]);
    expect(history.distinctPrimaries).toBe(2);
  });

  it('counts the rotation on a fraudulent account', async () => {
    // Five identities in a single day, which is what one of the accounts did.
    mockRows([
      {
        date: '2026-09-01',
        entries: [0, 1, 2, 3, 4].map(i => ({ primaryOrigin: `com.android.healthconnect.phone.j${i}` })),
      },
    ]);

    const history = await loadOriginHistory({ userId: 'u1', date: '2026-09-04' });
    expect(history.distinctPrimaries).toBe(5);
    expect(history.distinctPrimaries).toBeGreaterThan(ORIGIN_CHURN_MAX);
  });

  it('ignores entries with no primary origin', async () => {
    mockRows([
      { date: '2026-09-01', entries: [{ primaryOrigin: null }, { primaryOrigin: PLATFORM }] },
      { date: '2026-09-02', entries: [{}] },
      { date: '2026-09-03' },
    ]);

    const history = await loadOriginHistory({ userId: 'u1', date: '2026-09-04' });
    expect(history.distinctPrimaries).toBe(1);
    expect(history.establishedOrigins).toEqual([]);
  });

  it('returns an empty history when the read fails', async () => {
    // Empty means "nothing established", which only ever keeps a day OUT of a
    // future baseline window. It cannot clamp anyone today, so failing this way
    // is safe in a way that failing the baseline read would not be.
    StepProvenance.find.mockImplementation(() => {
      throw new Error('connection reset');
    });

    const history = await loadOriginHistory({ userId: 'u1', date: '2026-09-04' });
    expect(history).toEqual({ establishedOrigins: [], distinctPrimaries: 0 });
  });
});

describe('resolveOriginTrust — steps that account for nothing', () => {
  // Two real accounts reached the server with Health Connect data wearing a label
  // that no origin rule inspects. The first version of this file trusted every
  // reader that was not `health_connect`, which is the hole they came through.
  /** A window too short to hold the delta being tested. */
  const TIGHT = 15;

  it('refuses a large jump from a reader that named no source', () => {
    // bharat75321, 2026-09-06: the sensor had reported 1,725 all day and the
    // hourly histogram summed to exactly that. Then one app sync moved the total
    // to 15,931 with reader 'unknown', no method, no origins. The 14,206 was
    // Health Connect's and nothing said so.
    const result = resolveOriginTrust({
      reader: 'unknown',
      primaryOrigin: null,
      delta: 14_206,
      windowMinutes: 8.5,
      history: { establishedOrigins: [], distinctPrimaries: 0 },
    });

    expect(result.trusted).toBe(false);
    expect(result.reason).toMatch(/nothing accounting for them/);
  });

  it('refuses a large jump wearing the sensor label', () => {
    // s.chetanshetty23, 2026-09-06: +8,328 in a 30-minute window labelled
    // native_sensor. seedDayFromHealthConnect had folded a Health Connect total
    // into the service's own count.
    const result = resolveOriginTrust({
      reader: 'native_sensor',
      primaryOrigin: null,
      delta: 8_328,
      windowMinutes: 30.15,
      history: { establishedOrigins: [], distinctPrimaries: 0 },
    });
    expect(result.trusted).toBe(false);
  });

  it('leaves the ordinary unattributed sync alone', () => {
    // 28% of all ledger entries carry no reader, because a cold open races the
    // first resolve. 80% of those move the day by under 100 steps. Marking those
    // days untrusted would stop honest accounts ever building a baseline.
    for (const delta of [0, 10, 64, 306, 843, 1_999]) {
      const result = resolveOriginTrust({
        reader: 'unknown',
        primaryOrigin: null,
        delta,
        windowMinutes: TIGHT,
        history: { establishedOrigins: [], distinctPrimaries: 0 },
      });
      expect(result.trusted).toBe(true);
    }
  });

  it('trusts a whole day flushed after the phone was offline', () => {
    // The case a flat size threshold got wrong, and the reason the test is on
    // TIME. Five days with no network, then one sync carrying a full day. There
    // is nothing suspicious about it, and marking 14.8% of honest days untrusted
    // is what the size test actually did.
    const result = resolveOriginTrust({
      reader: 'native_sensor',
      primaryOrigin: null,
      delta: 9_500,
      windowMinutes: 5 * 24 * 60,
      history: { establishedOrigins: [], distinctPrimaries: 0 },
    });
    expect(result.trusted).toBe(true);
  });

  it('refuses the same figure when no time has passed', () => {
    // +16,475 against `offlineMinutes: 15` is in the real ledger. A quarter of an
    // hour cannot hold sixteen thousand steps, whoever reports it.
    const result = resolveOriginTrust({
      reader: 'native_sensor',
      primaryOrigin: null,
      delta: 16_475,
      windowMinutes: TIGHT,
      history: { establishedOrigins: [], distinctPrimaries: 0 },
    });
    expect(result.trusted).toBe(false);
  });

  it('does not let a missing window become a verdict on its own', () => {
    // A caller that reports no window must not make every delta unexplainable.
    const result = resolveOriginTrust({
      reader: 'native_sensor',
      primaryOrigin: null,
      delta: 200,
      windowMinutes: null,
      history: { establishedOrigins: [], distinctPrimaries: 0 },
    });
    expect(result.trusted).toBe(true);
  });

  it('judges a named Health Connect origin on its history, not on its size', () => {
    // The delta rule is only for readers that named nobody. A reader that DID name
    // its source is judged by the established/churn rules above, whatever the size.
    const result = resolveOriginTrust({
      reader: 'health_connect',
      primaryOrigin: FIT,
      delta: 14_206,
      windowMinutes: 1,
      history: { establishedOrigins: [FIT], distinctPrimaries: 1 },
    });
    expect(result.trusted).toBe(true);
  });
});
