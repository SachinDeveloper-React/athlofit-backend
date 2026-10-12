/**
 * The device-reported step-pipeline status.
 *
 * This is the only diagnostic channel the server cannot corroborate against
 * anything — nobody can verify a phone's claim about its own permission
 * dialog. So the properties worth pinning down are the ones that keep an
 * unverifiable report from becoming a misleading one:
 *
 *   · an unrecognised value becomes null ("this build does not say"), never a
 *     stored string that reads as a finding;
 *   · an all-null report is recognisable, so a timer-driven empty ping cannot
 *     overwrite a report that actually said something;
 *   · the summary names the most actionable cause, because a support reply to
 *     "never asked" is different from one to "explicitly refused".
 */
const {
  normaliseStepStatusReport,
  isEmptyStepStatusReport,
  summariseStepStatus,
} = require('../utils/stepStatusReport');

const NOW = new Date('2026-10-12T09:00:00Z').getTime();
const norm = (body, opts = {}) =>
  normaliseStepStatusReport(body, { now: NOW, ...opts });

describe('normaliseStepStatusReport', () => {
  it('maps a full, well-formed report', () => {
    const r = norm({
      permissions: { activityRecognition: 'granted', healthConnect: 'denied' },
      healthConnect: { availability: 'installed', hasStepWriter: false },
      localSteps: {
        today: 4231,
        date: '2026-10-12',
        readStatus: 'ok',
        readError: null,
      },
      lastSyncAttempt: {
        at: '2026-10-12T08:55:00Z',
        ok: false,
        error: 'network_error',
      },
      batteryOptimisationIgnored: true,
    });

    expect(r.activityPermission).toBe('granted');
    expect(r.healthConnectPermission).toBe('denied');
    expect(r.healthConnectAvailability).toBe('installed');
    expect(r.hasStepWriter).toBe(false);
    expect(r.localStepsToday).toBe(4231);
    expect(r.localStepsDate).toBe('2026-10-12');
    expect(r.readStatus).toBe('ok');
    expect(r.lastSyncOk).toBe(false);
    expect(r.lastSyncError).toBe('network_error');
    expect(r.batteryOptimisationIgnored).toBe(true);
    expect(r.reportedAt).toEqual(new Date(NOW));
  });

  describe('unknown input becomes null rather than being stored verbatim', () => {
    it.each([
      ['an invented permission state', { permissions: { activityRecognition: 'MAYBE' } }, 'activityPermission'],
      ['an invented availability', { healthConnect: { availability: 'probably' } }, 'healthConnectAvailability'],
      ['an invented read status', { localSteps: { readStatus: 'weird' } }, 'readStatus'],
      ['an invented sync error', { lastSyncAttempt: { error: 'gremlins' } }, 'lastSyncError'],
    ])('%s → null', (_label, body, field) => {
      expect(norm(body)[field]).toBeNull();
    });

    it('accepts known values case-insensitively', () => {
      expect(norm({ permissions: { activityRecognition: 'GRANTED' } }).activityPermission).toBe(
        'granted',
      );
    });

    it.each([
      ['a string', 'nonsense'],
      ['null', null],
      ['undefined', undefined],
      ['an array', []],
      ['a number', 42],
    ])('survives %s as the whole body', (_label, body) => {
      expect(() => norm(body)).not.toThrow();
      expect(isEmptyStepStatusReport(norm(body))).toBe(true);
    });
  });

  describe('numbers and dates are bounded', () => {
    it.each([
      ['a negative count', -5, null],
      ['a non-number', 'lots', null],
      ['a fractional count', 1234.7, 1235],
      ['an absurd count', 99_999_999, 1_000_000],
    ])('%s', (_label, input, expected) => {
      expect(norm({ localSteps: { today: input } }).localStepsToday).toBe(expected);
    });

    it('rejects a malformed local date', () => {
      expect(norm({ localSteps: { date: '12-10-2026' } }).localStepsDate).toBeNull();
    });

    it('rejects a sync attempt timestamp from the future', () => {
      // A device with a wrong clock would otherwise plant a "last attempt"
      // that never ages, and a reader cannot tell that from a fresh one.
      const r = norm({ lastSyncAttempt: { at: '2027-01-01T00:00:00Z' } });
      expect(r.lastSyncAttemptAt).toBeNull();
    });

    it('allows small clock skew', () => {
      const soon = new Date(NOW + 60 * 1000).toISOString();
      expect(norm({ lastSyncAttempt: { at: soon } }).lastSyncAttemptAt).not.toBeNull();
    });

    it('truncates a long read error', () => {
      const r = norm({ localSteps: { readError: 'x'.repeat(500) } });
      expect(r.readError.length).toBeLessThanOrEqual(200);
    });
  });

  it('takes the build from the header, never the body', () => {
    // A payload is replayable; the header is attached by the middleware on the
    // live request, so only it can be trusted to describe the sender.
    const r = norm(
      { reportedAppVersion: '9.9.9', permissions: { activityRecognition: 'granted' } },
      { appVersion: '1.80' },
    );
    expect(r.reportedAppVersion).toBe('1.80');
  });
});

describe('isEmptyStepStatusReport', () => {
  it('treats a report with only a timestamp as empty', () => {
    expect(isEmptyStepStatusReport(norm({}))).toBe(true);
  });

  it('treats any single real field as non-empty', () => {
    expect(isEmptyStepStatusReport(norm({ healthConnect: { hasStepWriter: false } }))).toBe(
      false,
    );
  });

  it('counts a false boolean as something said, not as absence', () => {
    // `false` here is a finding — "no app is writing steps" — and dropping it
    // for being falsy would discard the most useful report of all.
    expect(isEmptyStepStatusReport(norm({ lastSyncAttempt: { ok: false } }))).toBe(false);
  });

  it.each([[null], [undefined]])('treats %s as empty', (value) => {
    expect(isEmptyStepStatusReport(value)).toBe(true);
  });
});

describe('summariseStepStatus', () => {
  it('returns null when nothing was reported', () => {
    expect(summariseStepStatus(norm({}))).toBeNull();
    expect(summariseStepStatus(null)).toBeNull();
  });

  it('returns null when the report is conclusive-free', () => {
    // Everything granted and working — there is no device-side cause to name,
    // and the caller should fall back to server-side inference.
    const r = norm({
      permissions: { activityRecognition: 'granted', healthConnect: 'granted' },
      healthConnect: { availability: 'installed', hasStepWriter: true },
      localSteps: { readStatus: 'ok' },
    });
    expect(summariseStepStatus(r)).toBeNull();
  });

  it('reports a refusal ahead of everything else', () => {
    const r = norm({
      permissions: { activityRecognition: 'denied' },
      healthConnect: { availability: 'not_installed', hasStepWriter: false },
    });
    expect(summariseStepStatus(r).code).toBe('PERMISSION_DENIED');
  });

  it('distinguishes never-asked from refused', () => {
    const r = norm({ permissions: { healthConnect: 'never_asked' } });
    expect(summariseStepStatus(r).code).toBe('PERMISSION_NEVER_ASKED');
  });

  it.each([
    ['not_installed', 'HEALTH_CONNECT_MISSING'],
    ['update_required', 'HEALTH_CONNECT_OUTDATED'],
  ])('maps availability %s → %s', (availability, expected) => {
    const r = norm({
      permissions: { activityRecognition: 'granted' },
      healthConnect: { availability },
    });
    expect(summariseStepStatus(r).code).toBe(expected);
  });

  it('names the no-step-writer case, which looks identical to a broken app', () => {
    const r = norm({
      permissions: { activityRecognition: 'granted', healthConnect: 'granted' },
      healthConnect: { availability: 'installed', hasStepWriter: false },
    });
    expect(summariseStepStatus(r).code).toBe('NO_STEP_WRITER');
  });

  it('surfaces a sync that never reached the server', () => {
    const r = norm({
      permissions: { activityRecognition: 'granted' },
      lastSyncAttempt: { at: '2026-10-12T08:00:00Z', ok: false, error: 'auth_error' },
    });
    expect(summariseStepStatus(r).code).toBe('SYNC_FAILED_AUTH_ERROR');
  });

  it('does not call a successful sync a failure', () => {
    const r = norm({
      permissions: { activityRecognition: 'granted' },
      lastSyncAttempt: { at: '2026-10-12T08:00:00Z', ok: true },
    });
    expect(summariseStepStatus(r)).toBeNull();
  });
});
