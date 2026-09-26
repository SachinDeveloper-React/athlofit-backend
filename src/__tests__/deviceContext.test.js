// One phone must read as one install in the device history.
//
// Builds up to 1.81 send two install ids from the same phone — ANDROID_ID from
// the JS layer, a random UUID from the native foreground service — and they
// alternate with every sync. Each switch used to count as a new install and
// push a history entry, so the 20-entry cap was filled with the two ids taking
// turns and the real update trail was gone within hours.

const { isNewInstallSnapshot } = require('../middleware/deviceContext.middleware');

const build = { appVersion: '1.81', buildNumber: 81, osVersion: '15' };
const JS_ID = '7a93eaaa09e08a20';
const NATIVE_ID = '7621e9cc-7edc-4908-84d0-9870baf4dc5e';

describe('isNewInstallSnapshot', () => {
  it('records the first snapshot', () => {
    expect(isNewInstallSnapshot(null, { ...build, installId: JS_ID })).toBe(true);
  });

  it('does not record the same install again', () => {
    expect(
      isNewInstallSnapshot({ ...build, installId: JS_ID }, { ...build, installId: JS_ID }, []),
    ).toBe(false);
  });

  it('records the second id of a phone the first time it is seen', () => {
    const history = [{ ...build, installId: JS_ID }];
    expect(
      isNewInstallSnapshot({ ...build, installId: JS_ID }, { ...build, installId: NATIVE_ID }, history),
    ).toBe(true);
  });

  it('does not record a phone switching back to an id it was already seen with', () => {
    const history = [
      { ...build, installId: JS_ID },
      { ...build, installId: NATIVE_ID },
    ];
    expect(
      isNewInstallSnapshot({ ...build, installId: NATIVE_ID }, { ...build, installId: JS_ID }, history),
    ).toBe(false);
    expect(
      isNewInstallSnapshot({ ...build, installId: JS_ID }, { ...build, installId: NATIVE_ID }, history),
    ).toBe(false);
  });

  it('still records an update, even on a known id', () => {
    const history = [{ ...build, installId: JS_ID }];
    expect(
      isNewInstallSnapshot(
        { ...build, installId: JS_ID },
        { appVersion: '1.82', buildNumber: 82, osVersion: '15', installId: JS_ID },
        history,
      ),
    ).toBe(true);
  });

  it('still records an id never seen before — a second copy under another user profile', () => {
    const history = [{ ...build, installId: JS_ID }];
    expect(
      isNewInstallSnapshot({ ...build, installId: JS_ID }, { ...build, installId: 'fresh-id' }, history),
    ).toBe(true);
  });
});
