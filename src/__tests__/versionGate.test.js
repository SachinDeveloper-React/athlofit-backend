// The build-level step-sync gate can take down every user on a version at once,
// so its fail-open behaviour is the thing worth pinning: a gate that blocks by
// accident is worse than the bug it was added to contain.

const {
  compareVersions,
  checkStepSyncVersion,
  resolveUpdateRequirement,
  DEFAULT_MESSAGE,
} = require('../utils/versionGate');

const gate = (stepSync) => ({ stepSync });
const ctx = (appVersion) => ({ appVersion });

describe('compareVersions', () => {
  it('orders normal versions', () => {
    expect(compareVersions('1.71', '1.72')).toBe(-1);
    expect(compareVersions('1.72', '1.71')).toBe(1);
    expect(compareVersions('1.72', '1.72')).toBe(0);
  });

  it('treats missing components as zero', () => {
    expect(compareVersions('1.7', '1.7.0')).toBe(0);
    expect(compareVersions('1.7', '1.7.1')).toBe(-1);
    expect(compareVersions('2', '1.99.99')).toBe(1);
  });

  it('compares numerically, not lexically', () => {
    // '10' < '9' as strings; the whole point of parsing is that it must not.
    expect(compareVersions('1.10', '1.9')).toBe(1);
  });

  it('reads an unparseable component as zero rather than NaN', () => {
    // NaN comparisons are all false, so an unparseable version would fall
    // through every branch and land wherever the last `return` happened to be.
    expect(compareVersions('1.x', '1.0')).toBe(0);
    expect(compareVersions('', '0.0.0')).toBe(0);
  });
});

describe('checkStepSyncVersion — fail-open guarantees', () => {
  it('allows everything when the gate is disabled', () => {
    expect(
      checkStepSyncVersion(gate({ enabled: false, blockedVersions: ['1.72'] }), ctx('1.72')).blocked,
    ).toBe(false);
  });

  it('allows everything when the config predates the feature', () => {
    // Deployed configs have no stepSync block at all until one is written.
    expect(checkStepSyncVersion({}, ctx('1.72')).blocked).toBe(false);
    expect(checkStepSyncVersion(null, ctx('1.72')).blocked).toBe(false);
    expect(checkStepSyncVersion(undefined, undefined).blocked).toBe(false);
  });

  it('allows an unknown version unless explicitly told not to', () => {
    // Every build released before version headers existed reports nothing.
    // Blocking those by default would take out the entire pre-telemetry install
    // base the moment the gate is switched on for one bad build.
    const cfg = gate({ enabled: true, blockedVersions: ['1.72'] });
    expect(checkStepSyncVersion(cfg, ctx(null)).blocked).toBe(false);
    expect(checkStepSyncVersion(cfg, {}).blocked).toBe(false);
  });

  it('blocks an unknown version when blockUnknownVersion is set', () => {
    const cfg = gate({ enabled: true, blockUnknownVersion: true });
    const r = checkStepSyncVersion(cfg, ctx(null));
    expect(r.blocked).toBe(true);
    expect(r.rule).toBe('unknown_version');
  });
});

describe('checkStepSyncVersion — blocking rules', () => {
  it('blocks an exact listed version and nothing adjacent', () => {
    const cfg = gate({ enabled: true, blockedVersions: ['1.72'] });
    expect(checkStepSyncVersion(cfg, ctx('1.72')).blocked).toBe(true);
    expect(checkStepSyncVersion(cfg, ctx('1.71')).blocked).toBe(false);
    expect(checkStepSyncVersion(cfg, ctx('1.73')).blocked).toBe(false);
  });

  it('blocks everything below minVersion', () => {
    const cfg = gate({ enabled: true, minVersion: '1.73' });
    expect(checkStepSyncVersion(cfg, ctx('1.72')).blocked).toBe(true);
    expect(checkStepSyncVersion(cfg, ctx('1.73')).blocked).toBe(false);
    expect(checkStepSyncVersion(cfg, ctx('1.74')).blocked).toBe(false);
  });

  it('ignores an empty minVersion instead of blocking everyone', () => {
    // '' parses to 0, and every real version is >= 0, but relying on that is
    // fragile — the empty check is explicit and this pins it.
    const cfg = gate({ enabled: true, minVersion: '' });
    expect(checkStepSyncVersion(cfg, ctx('1.0')).blocked).toBe(false);
  });

  it('reports which rule fired, for the server log', () => {
    expect(
      checkStepSyncVersion(gate({ enabled: true, blockedVersions: ['1.72'] }), ctx('1.72')).rule,
    ).toBe('blocked_version');
    expect(
      checkStepSyncVersion(gate({ enabled: true, minVersion: '2.0' }), ctx('1.72')).rule,
    ).toBe('below_min_version');
  });

  it('falls back to the default message when none is configured', () => {
    // The message is the user's only instruction on how to fix this, so an
    // unconfigured gate must not show them an empty banner.
    const r = checkStepSyncVersion(gate({ enabled: true, blockedVersions: ['1.72'] }), ctx('1.72'));
    expect(r.reason).toBe(DEFAULT_MESSAGE);
  });

  it('uses the configured message when present', () => {
    const cfg = gate({ enabled: true, blockedVersions: ['1.72'], message: 'Update to 1.73.' });
    expect(checkStepSyncVersion(cfg, ctx('1.72')).reason).toBe('Update to 1.73.');
  });
});

describe('resolveUpdateRequirement — force-update verdict', () => {
  const cfg = (android) => ({ enabled: true, android });

  it('returns none when the feature is disabled', () => {
    const r = resolveUpdateRequirement(
      { enabled: false, android: { minVersion: '9.9', latestVersion: '9.9' } },
      'android',
      '1.72',
    );
    expect(r.updateRequired).toBe(false);
  });

  it('forces below minVersion and soft-prompts below latestVersion', () => {
    const c = cfg({ minVersion: '1.72', latestVersion: '1.74' });
    expect(resolveUpdateRequirement(c, 'android', '1.71').updateType).toBe('force');
    expect(resolveUpdateRequirement(c, 'android', '1.72').updateType).toBe('soft');
    expect(resolveUpdateRequirement(c, 'android', '1.73').updateType).toBe('soft');
    expect(resolveUpdateRequirement(c, 'android', '1.74').updateType).toBe('none');
    expect(resolveUpdateRequirement(c, 'android', '1.75').updateType).toBe('none');
  });

  it('never forces a client whose version could not be read', () => {
    // Answering "force" to an unknown version is how an entire install base
    // gets locked out by a client reporting bug rather than by a decision.
    // `force` has no dismiss in the app, so this must fail closed.
    const c = cfg({ minVersion: '2.0', latestVersion: '2.0' });
    expect(resolveUpdateRequirement(c, 'android', '').updateRequired).toBe(false);
    expect(resolveUpdateRequirement(c, 'android', null).updateRequired).toBe(false);
    expect(resolveUpdateRequirement(c, 'android', 'abc').updateRequired).toBe(false);
    expect(resolveUpdateRequirement(c, 'android', '1.2.x').updateRequired).toBe(false);
  });

  it('never hard-blocks a user who is already on the latest build', () => {
    // The typo case: '17.3' meant as '1.73'. Unclamped this forces everyone,
    // including someone who installed the newest build a minute ago, and a
    // forced modal cannot be dismissed.
    const c = cfg({ minVersion: '17.3', latestVersion: '1.73' });
    expect(resolveUpdateRequirement(c, 'android', '1.73').updateRequired).toBe(false);
    // Genuinely older clients are still pushed, so the intent survives.
    expect(resolveUpdateRequirement(c, 'android', '1.72').updateType).toBe('force');
  });

  it('keeps platforms independent', () => {
    // Android ships 1.72 while iOS is on 1.0; a shared floor would brick one
    // of them. The per-platform split is what makes divergent versions safe.
    const both = {
      enabled: true,
      android: { minVersion: '1.72', latestVersion: '1.72' },
      ios: { minVersion: '1.0', latestVersion: '1.0' },
    };
    expect(resolveUpdateRequirement(both, 'ios', '1.0').updateRequired).toBe(false);
    expect(resolveUpdateRequirement(both, 'android', '1.0').updateType).toBe('force');
  });

  it('returns none for an unknown platform rather than guessing', () => {
    const both = { enabled: true, android: { minVersion: '1.72', latestVersion: '1.72' } };
    expect(resolveUpdateRequirement(both, 'web', '1.0').updateRequired).toBe(false);
  });
});
