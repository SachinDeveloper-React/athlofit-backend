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

// ── Syncs that carry no steps at all ─────────────────────────────────────────
//
// Hydration and vitals post to /health/sync with no `steps` field. The caller
// used to drop these before resolveLogReason ever saw them, so even verbose
// tracing could not show them — and that hid the most diagnostic state a
// stalled account can be in: the app is alive and reaching the server, but has
// no step data to send. In the logs that looked identical to an app that had
// stopped syncing, and the two have completely different causes.
describe('resolveLogReason — payloads with no steps', () => {
  const base = {
    rejected: false,
    severity: 'none',
    flagged: false,
    corrected: false,
    incomingSteps: 0,
    clampedSteps: 0,
    existingSteps: 0,
  };

  it('is not recorded when nobody is watching the account', () => {
    expect(
      resolveLogReason({ ...base, stepsProvided: false, tracing: false }),
    ).toBeNull();
  });

  it('is recorded under its own reason while tracing is on', () => {
    expect(
      resolveLogReason({ ...base, stepsProvided: false, tracing: true }),
    ).toBe('trace_no_steps');
  });

  it('is distinguishable from a traced sync that did carry steps', () => {
    expect(
      resolveLogReason({ ...base, stepsProvided: true, tracing: true }),
    ).toBe('trace');
  });

  it('does not mistake a stored step count for an incoming one', () => {
    // A hydration sync on a day that already has 8,000 steps: existingSteps is
    // high, incomingSteps is 0. The large-jump rule must not fire, and neither
    // must the clamp rule — nothing was clamped, nothing was sent.
    expect(
      resolveLogReason({
        ...base,
        stepsProvided: false,
        tracing: false,
        existingSteps: 8000,
      }),
    ).toBeNull();
  });

  it('still reports a rejection ahead of everything else', () => {
    // A build-gated sync is refused before steps are even read.
    expect(
      resolveLogReason({
        ...base,
        stepsProvided: false,
        tracing: false,
        rejected: true,
      }),
    ).toBe('rejected');
  });

  it('defaults to treating a payload as carrying steps', () => {
    // Callers that predate the flag must keep their existing behaviour.
    const { stepsProvided, ...withoutFlag } = { ...base, stepsProvided: true };
    expect(resolveLogReason({ ...withoutFlag, tracing: true })).toBe('trace');
  });
});
