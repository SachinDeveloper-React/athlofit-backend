// The provenance layer exists to answer one question after the fact: a sync
// added 17,000 steps — where did they come from, and were they walked that day?
//
// These tests pin the parts of that answer that are computed rather than
// reported, and the normalisation that stands between an untrusted client
// payload and an admin screen.

const {
  normalizeStepSource,
  buildProvenanceEntry,
  mergeHourly,
  mergeOrigins,
  describeEntry,
  MAX_ORIGINS,
} = require('../utils/stepProvenance');

describe('normalizeStepSource', () => {
  it('keeps a well-formed block', () => {
    const out = normalizeStepSource({
      reader: 'health_connect',
      method: 'coverage-dedup',
      primaryOrigin: 'com.sec.android.app.shealth',
      origins: [
        { packageName: 'com.sec.android.app.shealth', steps: 12000, contributed: 12000, disjointFraction: 1 },
        { packageName: 'com.google.android.apps.fitness', steps: 11800, contributed: 0, disjointFraction: 0.05 },
      ],
      hourly: Array.from({ length: 24 }, (_, h) => (h >= 6 && h <= 21 ? 750 : 0)),
      recordedFrom: '2026-08-28T00:42:00.000Z',
      recordedTo: '2026-08-28T15:31:00.000Z',
      recordCount: 42,
      offlineMinutes: 3660,
    });

    expect(out.reader).toBe('health_connect');
    expect(out.origins).toHaveLength(2);
    expect(out.hourly[8]).toBe(750);
    expect(out.recordCount).toBe(42);
    expect(out.recordedFrom).toBeInstanceOf(Date);
  });

  it('returns null for a build that sends nothing', () => {
    // The distinction the ledger depends on: "this build does not report a
    // source" is a different fact from "the reader found no steps", and an
    // empty shell would erase it.
    expect(normalizeStepSource(undefined)).toBeNull();
    expect(normalizeStepSource({})).toBeNull();
    expect(normalizeStepSource('health_connect')).toBeNull();
  });

  it('rejects a reader it does not recognise', () => {
    // Every step investigation branches on the reader first, so an unknown value
    // must read as unknown rather than as a third kind of source.
    const out = normalizeStepSource({ reader: 'sweatcoin', recordCount: 3 });
    expect(out.reader).toBe('unknown');
  });

  it('clamps hostile input rather than storing it', () => {
    const out = normalizeStepSource({
      reader: 'health_connect',
      method: 'x'.repeat(500),
      origins: Array.from({ length: 50 }, (_, i) => ({
        packageName: `pkg.${i}`,
        steps: 9_999_999,
        contributed: -5,
        disjointFraction: 12,
      })),
      hourly: Array.from({ length: 200 }, () => 5_000_000),
      offlineMinutes: 99_999_999,
    });

    expect(out.method.length).toBeLessThanOrEqual(40);
    expect(out.origins).toHaveLength(MAX_ORIGINS);
    expect(out.origins[0].steps).toBe(100_000);
    expect(out.origins[0].contributed).toBe(0);
    expect(out.origins[0].disjointFraction).toBe(1);
    expect(out.hourly).toHaveLength(24);
    expect(out.offlineMinutes).toBe(365 * 24 * 60);
  });

  it('drops an all-zero histogram', () => {
    // 24 zeroes says nothing that an absent field does not, and storing it makes
    // "no timestamps available" look like "steps recorded at no time at all".
    const out = normalizeStepSource({
      reader: 'native_sensor',
      hourly: new Array(24).fill(0),
    });
    expect(out.hourly).toEqual([]);
  });
});

describe('buildProvenanceEntry', () => {
  const deviceCtx = { appVersion: '1.80', buildNumber: 80, platform: 'android', lastSource: 'worker' };

  it('records a same-day sync as not late', () => {
    const entry = buildProvenanceEntry({
      from: 4000,
      to: 4240,
      source: normalizeStepSource({ reader: 'health_connect', recordCount: 3 }),
      syncDate: '2026-08-28',
      // 14:30 IST on the same day.
      at: new Date('2026-08-28T09:00:00.000Z'),
      timezone: 'Asia/Kolkata',
      deviceCtx,
    });

    expect(entry.delta).toBe(240);
    expect(entry.daysLate).toBe(0);
    expect(entry.clientSource).toBe('worker');
  });

  // ── The case this whole model exists for ──────────────────────────────────
  it('marks a backlog delivered days after the day it belongs to', () => {
    const entry = buildProvenanceEntry({
      from: 0,
      to: 17240,
      source: normalizeStepSource({
        reader: 'health_connect',
        primaryOrigin: 'com.sec.android.app.shealth',
        recordCount: 61,
        offlineMinutes: 4320,
      }),
      syncDate: '2026-08-25',
      at: new Date('2026-08-28T09:00:00.000Z'),
      timezone: 'Asia/Kolkata',
      deviceCtx,
    });

    expect(entry.delta).toBe(17240);
    expect(entry.daysLate).toBe(3);
    expect(entry.offlineMinutes).toBe(4320);
  });

  it('measures lateness in the user\'s day, not the server\'s', () => {
    // 23:40 IST on the 28th is already the 29th in UTC. Resolving lateness
    // against the server day would report every evening sync from an IST user
    // as a day late, which would make the field useless precisely where the
    // users are.
    const entry = buildProvenanceEntry({
      from: 9000,
      to: 9500,
      source: null,
      syncDate: '2026-08-28',
      at: new Date('2026-08-28T18:10:00.000Z'),
      timezone: 'Asia/Kolkata',
      deviceCtx,
    });

    expect(entry.daysLate).toBe(0);
  });

  it('still records an increase from a build that reports no source', () => {
    // A gap in the ledger would read as no steps having arrived, which is a
    // worse answer than "steps arrived and nothing said where from".
    const entry = buildProvenanceEntry({
      from: 100,
      to: 120,
      source: null,
      syncDate: '2026-08-28',
      at: new Date('2026-08-28T09:00:00.000Z'),
      timezone: 'Asia/Kolkata',
      deviceCtx: null,
    });

    expect(entry.delta).toBe(20);
    expect(entry.reader).toBe('unknown');
    expect(entry.origins).toEqual([]);
  });
});

describe('mergeHourly', () => {
  it('takes the element-wise max, not the sum', () => {
    // Each read reports the day cumulatively from local midnight, so the 09:00
    // slot in the 10am sync and in the 6pm sync describe the same steps. Adding
    // them would multiply the day by however often the device happened to sync.
    const morning = [0, 0, 0, 0, 0, 0, 0, 0, 0, 500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const evening = [0, 0, 0, 0, 0, 0, 0, 0, 0, 500, 0, 0, 0, 0, 0, 0, 0, 0, 900, 0, 0, 0, 0, 0];

    const merged = mergeHourly(morning, evening);
    expect(merged[9]).toBe(500);
    expect(merged[18]).toBe(900);
  });

  it('adopts the first histogram it is given', () => {
    const incoming = new Array(24).fill(10);
    expect(mergeHourly([], incoming)).toEqual(incoming);
    expect(mergeHourly(undefined, incoming)).toEqual(incoming);
  });

  it('keeps what it has when a sync carries no histogram', () => {
    const existing = new Array(24).fill(7);
    expect(mergeHourly(existing, undefined)).toEqual(existing);
  });
});

describe('mergeOrigins', () => {
  it('keeps an origin that has stopped appearing', () => {
    // Health Connect stops returning an app's records when it is uninstalled or
    // its permission is revoked. Dropping the origin would erase the attribution
    // for steps that are still counted in the day's stored total.
    const merged = mergeOrigins(
      [{ packageName: 'com.uninstalled.app', steps: 4000, contributed: 4000, disjointFraction: 1 }],
      [{ packageName: 'com.sec.android.app.shealth', steps: 6000, contributed: 6000, disjointFraction: 1 }],
    );

    expect(merged.map(o => o.packageName).sort()).toEqual([
      'com.sec.android.app.shealth',
      'com.uninstalled.app',
    ]);
  });

  it('holds an origin at its high-water mark', () => {
    const merged = mergeOrigins(
      [{ packageName: 'a', steps: 9000, contributed: 9000, disjointFraction: 1 }],
      [{ packageName: 'a', steps: 3000, contributed: 3000, disjointFraction: 1 }],
    );
    expect(merged[0].steps).toBe(9000);
  });

  it('takes the latest mirror verdict rather than the highest', () => {
    // Whether an origin duplicates another is a judgement about the current
    // data. A stale high value would keep claiming independence for a source now
    // judged a duplicate.
    const merged = mergeOrigins(
      [{ packageName: 'a', steps: 500, contributed: 500, disjointFraction: 0.95 }],
      [{ packageName: 'a', steps: 500, contributed: 0, disjointFraction: 0.02 }],
    );
    expect(merged[0].disjointFraction).toBe(0.02);
  });
});

describe('describeEntry', () => {
  it('explains a late Health Connect backlog in one line', () => {
    const line = describeEntry({
      delta: 17240,
      from: 0,
      to: 17240,
      reader: 'health_connect',
      primaryOrigin: 'com.sec.android.app.shealth',
      origins: [
        { packageName: 'com.sec.android.app.shealth', steps: 17240, contributed: 17240 },
        { packageName: 'com.google.android.apps.fitness', steps: 16900, contributed: 0 },
      ],
      recordedFrom: new Date('2026-08-25T01:00:00.000Z'),
      recordedTo: new Date('2026-08-25T16:30:00.000Z'),
      recordCount: 61,
      daysLate: 3,
      offlineMinutes: 4320,
      clientSource: 'worker',
    });

    expect(line).toContain('+17,240 steps');
    expect(line).toContain('com.sec.android.app.shealth');
    // The two facts that turn an alarming number into an ordinary one.
    expect(line).toContain('3 days late');
    expect(line).toContain('01:00–16:30');
    // And the origin that was deliberately not counted, so "my steps are
    // missing" is answerable from the same line.
    expect(line).toContain('not counted');
  });

  it('says plainly when the sensor cannot break the figure down', () => {
    const line = describeEntry({
      delta: 240, from: 4000, to: 4240,
      reader: 'native_sensor', origins: [], daysLate: 0, recordCount: 0,
    });
    expect(line).toContain('hardware step sensor');
  });

  it('names a build that reports no source at all', () => {
    const line = describeEntry({
      delta: 20, from: 100, to: 120,
      reader: 'unknown', origins: [], daysLate: 0, recordCount: 0,
    });
    expect(line).toContain('does not report its step source');
  });
});
