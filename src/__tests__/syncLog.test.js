// The sampling decision is the whole design of SyncLog: too permissive and a
// debugging aid becomes six-figure daily writes, too strict and it fails to
// record the one sync someone needed. These pin both edges.

const { resolveLogReason, isTracing, LARGE_JUMP_STEPS } = require('../utils/syncLog');

const base = {
  tracing: false,
  rejected: false,
  severity: 'none',
  flagged: false,
  corrected: false,
  incomingSteps: 1000,
  clampedSteps: 1000,
  existingSteps: 900,
};
const call = (over) => resolveLogReason({ ...base, ...over });

describe('resolveLogReason — what gets kept', () => {
  it('skips an ordinary sync', () => {
    // The common case by a wide margin: a device posting a small increase every
    // 15 minutes. Recording these is what would blow the collection up.
    expect(call({})).toBeNull();
  });

  it('skips a no-op re-send', () => {
    expect(call({ incomingSteps: 900, clampedSteps: 900, existingSteps: 900 })).toBeNull();
  });

  it('keeps a sync the validator changed', () => {
    // The single most useful row to have: stored is not what the device said.
    expect(call({ incomingSteps: 9000, clampedSteps: 4000 })).toBe('clamped');
  });

  it('keeps an implausible submission ahead of any other label', () => {
    expect(call({ severity: 'implausible', incomingSteps: 99999, clampedSteps: 5000 }))
      .toBe('implausible');
  });

  it('keeps a rejected sync ahead of everything', () => {
    // A 403 from either gate. Ranked first because "the server refused this"
    // outranks whatever the validator would have said about the number.
    expect(call({ rejected: true, severity: 'implausible' })).toBe('rejected');
  });

  it('keeps a client-flagged downward correction', () => {
    expect(call({ corrected: true })).toBe('corrected');
  });

  it('keeps a flagged-but-unclamped sync', () => {
    expect(call({ flagged: true })).toBe('flagged');
  });

  it('keeps a large jump the validator was happy with', () => {
    // The reported bug was 5,000-step jumps that passed validation. Without
    // this rule those syncs are invisible, which is how it went unexplained.
    expect(call({ incomingSteps: 900 + LARGE_JUMP_STEPS, clampedSteps: 900 + LARGE_JUMP_STEPS }))
      .toBe('large_jump');
    expect(call({ incomingSteps: 6000, clampedSteps: 6000, existingSteps: 1000 }))
      .toBe('large_jump');
  });

  it('leaves a jump just under the threshold alone', () => {
    const s = 900 + LARGE_JUMP_STEPS - 1;
    expect(call({ incomingSteps: s, clampedSteps: s })).toBeNull();
  });

  it('keeps everything while tracing is on', () => {
    expect(call({ tracing: true })).toBe('trace');
  });

  it('prefers the specific reason over the generic trace label', () => {
    // With tracing on, a clamped sync must still be labelled 'clamped' —
    // otherwise the interesting rows are indistinguishable from the noise.
    expect(call({ tracing: true, incomingSteps: 9000, clampedSteps: 4000 })).toBe('clamped');
  });
});

describe('isTracing', () => {
  const future = new Date(Date.now() + 3600_000);
  const past = new Date(Date.now() - 3600_000);

  it('is off by default', () => {
    expect(isTracing({})).toBe(false);
    expect(isTracing(null)).toBe(false);
    expect(isTracing({ syncDebug: { enabled: false } })).toBe(false);
  });

  it('is on within the window', () => {
    expect(isTracing({ syncDebug: { enabled: true, expiresAt: future } })).toBe(true);
  });

  it('expires on its own', () => {
    // Tracing left on forever silently becomes "log everything" for that
    // account, which is the volume problem the sampling exists to avoid.
    expect(isTracing({ syncDebug: { enabled: true, expiresAt: past } })).toBe(false);
  });

  it('treats a missing expiry as on, so an explicit enable is never ignored', () => {
    expect(isTracing({ syncDebug: { enabled: true, expiresAt: null } })).toBe(true);
  });
});
