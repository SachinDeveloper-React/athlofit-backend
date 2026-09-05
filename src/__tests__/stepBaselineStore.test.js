// Tests for the read behind the per-user step ceiling.
//
// The policy itself (percentile, floor, roof) is pure and tested in
// stepValidation.test.js. What is left here is everything that decides WHICH
// days the policy is handed, plus the failure behaviour — and the failure
// behaviour is the part that matters most, because a read that fails open
// weakens a ceiling while a read that fails closed zeroes a real user's steps.

jest.mock('../models/HealthActivity.model', () => ({ find: jest.fn() }));

const HealthActivity = require('../models/HealthActivity.model');
const { loadStepBaseline, shiftDate } = require('../utils/stepBaselineStore');
const {
  BASELINE_FLOOR,
  BASELINE_WINDOW_DAYS,
} = require('../utils/stepValidation');

/** Makes HealthActivity.find(...).lean() resolve to `rows`. */
const mockRows = rows => {
  HealthActivity.find.mockReturnValue({ lean: () => Promise.resolve(rows) });
};

const days = (n, steps, bonusSteps = 0) =>
  Array.from({ length: n }, () => ({ steps, bonusSteps }));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('shiftDate', () => {
  it('walks back inside a month', () => {
    expect(shiftDate('2026-09-30', 2)).toBe('2026-09-28');
  });

  it('crosses a month boundary', () => {
    expect(shiftDate('2026-09-04', 28)).toBe('2026-08-07');
  });

  it('crosses a year boundary', () => {
    expect(shiftDate('2026-01-05', 10)).toBe('2025-12-26');
  });

  it('handles a leap day', () => {
    expect(shiftDate('2028-03-01', 1)).toBe('2028-02-29');
  });
});

describe('loadStepBaseline — which days are read', () => {
  it('asks for the trailing window and EXCLUDES the day being validated', () => {
    // The exclusion is the point. A window that included today would let an
    // inflated sync raise the ceiling that is meant to refuse it.
    mockRows([]);

    return loadStepBaseline({ userId: 'u1', date: '2026-09-04' }).then(() => {
      const [filter] = HealthActivity.find.mock.calls[0];
      expect(filter.user).toBe('u1');
      expect(filter.date.$lt).toBe('2026-09-04');
      expect(filter.date.$gte).toBe(shiftDate('2026-09-04', BASELINE_WINDOW_DAYS));
    });
  });

  it('excludes days whose step source the account has no history with', () => {
    // The ratchet. Without this filter a spoofer sitting just under their ceiling
    // every day would have those days counted as history, raising the ceiling,
    // and could climb from the floor to the roof over two windows.
    //
    // `$ne: false`, not `true` — rows written before the field existed have no
    // value and must still count, or every user's history vanishes on deploy.
    mockRows([]);

    return loadStepBaseline({ userId: 'u1', date: '2026-09-04' }).then(() => {
      const [filter] = HealthActivity.find.mock.calls[0];
      expect(filter.originTrusted).toEqual({ $ne: false });
    });
  });

  it('counts walked steps only, not admin-credited bonus', () => {
    // A support gesture must not raise what the account is allowed to walk.
    mockRows(days(10, 22_000, 20_000)); // 2,000 walked per day

    return loadStepBaseline({ userId: 'u1', date: '2026-09-04' }).then(result => {
      // 2,000 * 1.75 is under the floor, so the floor is the answer. If bonus had
      // leaked in, the p90 would be 22,000 and the ceiling the roof instead.
      expect(result).toBe(BASELINE_FLOOR);
    });
  });

  it('gives an account with no history the floor', () => {
    mockRows([]);
    return expect(
      loadStepBaseline({ userId: 'u1', date: '2026-09-04' }),
    ).resolves.toBe(BASELINE_FLOOR);
  });

  it('characterises an account with a real history', () => {
    mockRows([...days(25, 4_000), ...days(3, 11_000)]);
    return expect(
      loadStepBaseline({ userId: 'u1', date: '2026-09-04' }),
    ).resolves.toBe(Math.ceil(11_000 * 1.75));
  });

  it('treats a missing bonusSteps field as zero rather than NaN', () => {
    // Rows written before bonusSteps existed. Arithmetic on undefined would make
    // every walked total NaN, every day get filtered out, and the ceiling silently
    // collapse to the floor for long-standing accounts.
    mockRows(Array.from({ length: 10 }, () => ({ steps: 11_000 })));
    return expect(
      loadStepBaseline({ userId: 'u1', date: '2026-09-04' }),
    ).resolves.toBe(Math.ceil(11_000 * 1.75));
  });
});

describe('loadStepBaseline — failure opens, never closes', () => {
  it('returns null when the read throws', async () => {
    // Null means "not characterised", which validateSteps reads as "apply only the
    // population bounds". Returning 0 or the floor here would let a database
    // hiccup clamp every honest user to a number they did not earn.
    HealthActivity.find.mockImplementation(() => {
      throw new Error('connection reset');
    });
    await expect(
      loadStepBaseline({ userId: 'u1', date: '2026-09-04' }),
    ).resolves.toBeNull();
  });

  it('returns null when the query rejects', async () => {
    HealthActivity.find.mockReturnValue({
      lean: () => Promise.reject(new Error('timeout')),
    });
    await expect(
      loadStepBaseline({ userId: 'u1', date: '2026-09-04' }),
    ).resolves.toBeNull();
  });
});
