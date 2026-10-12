/**
 * The "why does this user show 0 steps?" verdict.
 *
 * This is read by whoever is answering a support ticket, and it will be
 * believed. The properties worth pinning down are therefore less about the
 * strings and more about ORDER: a cause the server itself created must be
 * reported ahead of any inference drawn from the silence that cause produced.
 * Get that wrong and an account the server is actively turning away gets
 * reported as "the app has stopped contacting the server", sending support to
 * the user's phone for a problem that lives in config.
 */
const {
  resolveStepDiagnosisVerdict,
  ACTIVE_WINDOW_HOURS,
} = require('../utils/stepDiagnosis');

/** A user whose steps are flowing normally — the baseline each case perturbs. */
const healthy = {
  stepsTrackingEnabled: true,
  buildGateBlocked: false,
  hasTelemetry: true,
  everSynced: true,
  todaySteps: 8_000,
  hoursSinceActive: 1,
  hoursSinceStepData: 1,
  rejectedSyncs: 0,
  clampedSyncs: 0,
};

const verdict = (overrides = {}) =>
  resolveStepDiagnosisVerdict({ ...healthy, ...overrides });

describe('resolveStepDiagnosisVerdict', () => {
  it('reports a healthy account as healthy', () => {
    expect(verdict().code).toBe('HEALTHY');
  });

  describe('server-side causes outrank anything inferred from silence', () => {
    // Each of these would ALSO satisfy a later branch — they are all paired
    // with a totally silent, never-synced, long-dormant account — so if the
    // ordering regressed, the later branch would win and the admin would be
    // told to go looking at the device.
    const alsoLooksDead = {
      everSynced: false,
      todaySteps: 0,
      hoursSinceActive: null,
    };

    it('reports the admin kill switch before anything else', () => {
      expect(
        verdict({
          ...alsoLooksDead,
          stepsTrackingEnabled: false,
          buildGateBlocked: true,
          rejectedSyncs: 5,
        }).code,
      ).toBe('STEPS_DISABLED_BY_ADMIN');
    });

    it('reports a blocked build before the silence it causes', () => {
      expect(
        verdict({ ...alsoLooksDead, buildGateBlocked: true, rejectedSyncs: 5 }).code,
      ).toBe('BUILD_BLOCKED');
    });

    it('reports server rejections before "app not running"', () => {
      expect(verdict({ ...alsoLooksDead, rejectedSyncs: 3 }).code).toBe('SYNCS_REJECTED');
    });

    it('quotes the admin reason so support can repeat it verbatim', () => {
      const v = verdict({
        stepsTrackingEnabled: false,
        stepsTrackingReason: 'Sensor reported 90k steps/day',
      });
      expect(v.detail).toContain('Sensor reported 90k steps/day');
    });
  });

  describe('never synced — splits on whether the app ever authenticated', () => {
    it('is NEVER_USED_APP when nothing has ever reached the server', () => {
      expect(verdict({ everSynced: false, hoursSinceActive: null }).code).toBe(
        'NEVER_USED_APP',
      );
    });

    it('is APP_RUNS_BUT_NEVER_SENT_STEPS when requests arrive but steps never have', () => {
      // The distinction the whole endpoint exists for: the app is demonstrably
      // working, so this is a permission / Health Connect problem, not a
      // "user never opened the app" problem.
      const v = verdict({ everSynced: false, hoursSinceActive: 2 });
      expect(v.code).toBe('APP_RUNS_BUT_NEVER_SENT_STEPS');
      expect(v.detail).toMatch(/permission|Health Connect/);
    });
  });

  describe('the app-alive / app-dead split', () => {
    it('calls a long-dormant account APP_NOT_RUNNING', () => {
      expect(verdict({ todaySteps: 0, hoursSinceActive: 72 }).code).toBe(
        'APP_NOT_RUNNING',
      );
    });

    it('calls a recently-active account with no steps a DEVICE problem', () => {
      const v = verdict({ todaySteps: 0, hoursSinceActive: 1 });
      expect(v.code).toBe('APP_ALIVE_BUT_NO_STEPS');
      expect(v.detail).toMatch(/permission|Health Connect|step-writing/);
    });

    it.each([
      ['just inside the window', ACTIVE_WINDOW_HOURS - 0.5, 'APP_ALIVE_BUT_NO_STEPS'],
      ['exactly on the boundary', ACTIVE_WINDOW_HOURS, 'APP_ALIVE_BUT_NO_STEPS'],
      ['just outside the window', ACTIVE_WINDOW_HOURS + 0.5, 'APP_NOT_RUNNING'],
    ])('%s (%sh) → %s', (_label, hours, expected) => {
      expect(verdict({ todaySteps: 0, hoursSinceActive: hours }).code).toBe(expected);
    });

    it('mentions how long ago steps were last seen, when known', () => {
      expect(
        verdict({ todaySteps: 0, hoursSinceActive: 1, hoursSinceStepData: 50 }).detail,
      ).toContain('50h ago');
    });

    it('omits the step-recency sentence when it is not known', () => {
      expect(
        verdict({ todaySteps: 0, hoursSinceActive: 1, hoursSinceStepData: null }).detail,
      ).not.toContain('Last steps actually received');
    });
  });

  describe('steps are arriving', () => {
    it('flags clamping only once steps actually exist', () => {
      expect(verdict({ clampedSyncs: 2 }).code).toBe('STEPS_CLAMPED');
    });

    it('does not let clamping mask a device with no steps at all', () => {
      // A clamped sync earlier in the week says nothing about why today is
      // empty, and the device answer is the more useful one.
      expect(verdict({ todaySteps: 0, clampedSyncs: 2 }).code).toBe(
        'APP_ALIVE_BUT_NO_STEPS',
      );
    });

    it('calls out a pre-telemetry build even when everything works', () => {
      expect(verdict({ hasTelemetry: false }).code).toBe('HEALTHY_NO_TELEMETRY');
    });
  });

  describe('a device report outranks inference, but not observed server facts', () => {
    const reported = { code: 'PERMISSION_DENIED', label: 'User refused step permission' };

    it('uses the device report instead of deducing from silence', () => {
      // Without the report this is APP_ALIVE_BUT_NO_STEPS — a correct but
      // vaguer answer that sends support hunting through three possibilities.
      const v = verdict({ todaySteps: 0, hoursSinceActive: 1, deviceReport: reported });
      expect(v.code).toBe('PERMISSION_DENIED');
      expect(v.source).toBe('device');
    });

    it('still reports the admin kill switch ahead of the device', () => {
      expect(
        verdict({ stepsTrackingEnabled: false, deviceReport: reported }).code,
      ).toBe('STEPS_DISABLED_BY_ADMIN');
    });

    it('still reports a blocked build ahead of the device', () => {
      expect(verdict({ buildGateBlocked: true, deviceReport: reported }).code).toBe(
        'BUILD_BLOCKED',
      );
    });

    it('still reports server-side rejections ahead of the device', () => {
      expect(verdict({ rejectedSyncs: 2, deviceReport: reported }).code).toBe(
        'SYNCS_REJECTED',
      );
    });

    it('marks server-deduced verdicts as such', () => {
      expect(verdict({ todaySteps: 0, hoursSinceActive: 1 }).source).toBe('server');
    });
  });

  describe('the app has steps the server does not', () => {
    it('calls it a delivery problem, not a device-read problem', () => {
      const v = verdict({ todaySteps: 0, hoursSinceActive: 1, localStepsToday: 6_200 });
      expect(v.code).toBe('APP_HAS_STEPS_SERVER_DOES_NOT');
      expect(v.detail).toContain('6200');
      expect(v.source).toBe('device');
    });

    it('does not fire when the server has the steps too', () => {
      expect(verdict({ todaySteps: 6_200, localStepsToday: 6_200 }).code).toBe('HEALTHY');
    });

    it('does not fire when the app also reports zero', () => {
      // Both agree there are no steps — that is the device-read question
      // again, not a delivery failure.
      expect(verdict({ todaySteps: 0, hoursSinceActive: 1, localStepsToday: 0 }).code).toBe(
        'APP_ALIVE_BUT_NO_STEPS',
      );
    });

    it('yields to an explicit device report, which names the actual cause', () => {
      expect(
        verdict({
          todaySteps: 0,
          hoursSinceActive: 1,
          localStepsToday: 6_200,
          deviceReport: { code: 'SYNC_FAILED_NETWORK_ERROR', label: 'Sync never arrived' },
        }).code,
      ).toBe('SYNC_FAILED_NETWORK_ERROR');
    });
  });

  it('always returns a code, label and detail', () => {
    const cases = [
      {},
      { stepsTrackingEnabled: false },
      { buildGateBlocked: true },
      { rejectedSyncs: 1 },
      { everSynced: false, hoursSinceActive: null },
      { everSynced: false, hoursSinceActive: 1 },
      { todaySteps: 0, hoursSinceActive: 100 },
      { todaySteps: 0 },
      { clampedSyncs: 1 },
      { hasTelemetry: false },
    ];
    for (const c of cases) {
      const v = verdict(c);
      expect(typeof v.code).toBe('string');
      expect(v.label).toBeTruthy();
      expect(v.detail).toBeTruthy();
    }
  });
});
