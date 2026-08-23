// Covers the two mechanisms added for build telemetry and the per-user step
// kill switch. Both have a default-open failure mode that would be invisible in
// manual testing and catastrophic in production — a wrong default here either
// switches off the entire user base or silently lets a paused device keep
// earning — so the defaults are pinned by test rather than by reading.

const {
  isStepsTrackingEnabled,
  stepsTrackingStatus,
  DEFAULT_REASON,
} = require('../utils/stepsTracking');
const { readDeviceHeaders } = require('../middleware/deviceContext.middleware');

describe('stepsTracking — enabled resolution', () => {
  it('treats a user with no stepsTracking sub-document as enabled', () => {
    // Every user that predates this field has no sub-document. Reading absence
    // as "disabled" would pause step tracking for the entire existing user base
    // on the deploy that ships it.
    expect(isStepsTrackingEnabled({})).toBe(true);
    expect(isStepsTrackingEnabled({ stepsTracking: {} })).toBe(true);
    expect(isStepsTrackingEnabled({ stepsTracking: { enabled: undefined } })).toBe(true);
  });

  it('is disabled only on an explicit false', () => {
    expect(isStepsTrackingEnabled({ stepsTracking: { enabled: false } })).toBe(false);
    expect(isStepsTrackingEnabled({ stepsTracking: { enabled: true } })).toBe(true);
  });

  it('tolerates a null/undefined user rather than throwing', () => {
    // Called from request paths where req.user could be absent; a throw here
    // would 500 the endpoint instead of failing open.
    expect(isStepsTrackingEnabled(null)).toBe(true);
    expect(isStepsTrackingEnabled(undefined)).toBe(true);
  });
});

describe('stepsTracking — client status payload', () => {
  it('reports no reason while enabled', () => {
    const status = stepsTrackingStatus({ stepsTracking: { enabled: true, reason: 'stale' } });
    expect(status).toEqual({ enabled: true, reason: null, disabledAt: null });
  });

  it('falls back to the default reason when an admin supplied none', () => {
    // The reason is rendered verbatim in the app's warning banner, so an empty
    // one would show the user a blank explanation for a frozen step count.
    const status = stepsTrackingStatus({ stepsTracking: { enabled: false, reason: '' } });
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe(DEFAULT_REASON);
  });

  it('passes an admin-written reason through unchanged', () => {
    const status = stepsTrackingStatus({
      stepsTracking: { enabled: false, reason: 'Sensor reporting impossible values.' },
    });
    expect(status.reason).toBe('Sensor reporting impossible values.');
  });
});

describe('deviceContext — header parsing', () => {
  const req = (headers) => ({ headers });

  it('reads a full set of headers', () => {
    const d = readDeviceHeaders(req({
      'x-app-version': '1.72',
      'x-app-build': '72',
      'x-platform': 'android',
      'x-os-version': '14',
      'x-device-model': 'Pixel 7',
      'x-device-brand': 'Google',
      'x-install-id': 'abc-123',
      'x-client-source': 'native_service',
    }));
    expect(d).toEqual({
      appVersion: '1.72',
      buildNumber: 72,
      platform: 'android',
      osVersion: '14',
      model: 'Pixel 7',
      manufacturer: 'Google',
      installId: 'abc-123',
      lastSource: 'native_service',
    });
  });

  it('returns nulls for a request with no headers at all', () => {
    // This is the old-build case, and the all-null result is meaningful: it is
    // what tells us a device has NOT taken the update.
    const d = readDeviceHeaders(req({}));
    expect(d.appVersion).toBeNull();
    expect(d.buildNumber).toBeNull();
    expect(d.platform).toBeNull();
    expect(d.installId).toBeNull();
  });

  it('defaults the client source to "app" when unspecified', () => {
    expect(readDeviceHeaders(req({ 'x-app-version': '1.72' })).lastSource).toBe('app');
  });

  it('rejects a non-numeric build rather than storing NaN', () => {
    // buildNumber is a Number in the schema; Number('abc') is NaN, which Mongo
    // stores and every later comparison silently fails against.
    expect(readDeviceHeaders(req({ 'x-app-build': 'abc' })).buildNumber).toBeNull();
    expect(readDeviceHeaders(req({ 'x-app-build': '' })).buildNumber).toBeNull();
    expect(readDeviceHeaders(req({ 'x-app-build': '12.3' })).buildNumber).toBeNull();
  });

  it('rejects an unrecognised platform instead of persisting it', () => {
    // device.platform is an enum; an arbitrary value fails validation on save.
    expect(readDeviceHeaders(req({ 'x-platform': 'windows' })).platform).toBeNull();
    expect(readDeviceHeaders(req({ 'x-platform': 'ANDROID' })).platform).toBe('android');
  });

  it('truncates over-long values so a hostile client cannot bloat the document', () => {
    const d = readDeviceHeaders(req({
      'x-app-version': 'v'.repeat(500),
      'x-device-model': 'm'.repeat(500),
    }));
    expect(d.appVersion).toHaveLength(32);
    expect(d.model).toHaveLength(80);
  });

  it('treats a whitespace-only header as absent', () => {
    expect(readDeviceHeaders(req({ 'x-app-version': '   ' })).appVersion).toBeNull();
  });
});
