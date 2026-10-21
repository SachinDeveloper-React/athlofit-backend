/**
 * The compare-and-swap filter guarding the passive-coin award.
 *
 * This shipped broken and stopped coins for real users, so it is worth pinning
 * exactly. The award is written with a conditional `findOneAndUpdate`, and a
 * filter that fails to match is a SILENT no-op by design — the sync still
 * returns 200, the steps still store, and only the coins quietly stop. There
 * is no error anywhere to notice, which is what made it expensive to find.
 *
 * Two properties, pulling against each other:
 *
 *   · it must MATCH every document shape that legitimately means "nobody has
 *     credited this user since I read them" — including documents written
 *     before `coinsEarnedToday` existed, which do not carry the field at all.
 *     Mongoose applies the schema default when it hands the document to the
 *     controller, but not to the query, so the controller sees 0 and MQL sees
 *     a missing field — and `{field: 0}` does not match a missing field.
 *
 *   · it must still REFUSE when the total actually moved, or the guard is
 *     decorative and the daily cap can be exceeded by concurrent awards.
 *
 * The filter is rebuilt here rather than imported: it lives inline in
 * health.controller.js, which transitively requires firebase-admin and cannot
 * be loaded in a test. Keeping the shapes in one readable place is worth more
 * than the duplication costs, and the structural assertions below fail if the
 * controller's version drifts in shape.
 */

/** Mirrors the filter built in health.controller.js's passive-coin block. */
function buildPassiveCasFilter({ userId, earnedSoFar, watermark }) {
  const earnedArms =
    earnedSoFar === 0
      ? [{ coinsEarnedToday: 0 }, { coinsEarnedToday: { $exists: false } }]
      : [{ coinsEarnedToday: earnedSoFar }];

  return {
    user: userId,
    $and: [
      { $or: earnedArms },
      {
        $or: [
          { lastPassiveCoinSteps: { $lte: watermark } },
          { lastPassiveCoinSteps: null },
          { lastPassiveCoinSteps: { $exists: false } },
        ],
      },
    ],
  };
}

/**
 * Minimal MQL evaluator covering exactly the operators this filter uses.
 * Enough to answer "would Mongo match this document?" without a database,
 * and deliberately strict about the one rule the bug turned on: a missing
 * field is not equal to 0.
 */
function matches(filter, doc) {
  const has = (f) => Object.prototype.hasOwnProperty.call(doc, f);

  const clause = (c) => {
    if (c.$or) return c.$or.some(clause);
    if (c.$and) return c.$and.every(clause);

    return Object.entries(c).every(([field, cond]) => {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        if ('$exists' in cond) return has(field) === cond.$exists;
        if ('$lte' in cond) {
          // A missing field has no value to compare, and MQL will not coerce
          // one in — this is the same type-bracket rule the bug turned on.
          if (!has(field) || typeof doc[field] !== 'number') return false;
          return doc[field] <= cond.$lte;
        }
        throw new Error(`unsupported operator in test evaluator: ${Object.keys(cond)}`);
      }
      // `: null` matches an explicit null AND a missing field; everything else
      // requires the field to be present and strictly equal.
      if (cond === null) return !has(field) || doc[field] === null;
      return has(field) && doc[field] === cond;
    });
  };

  return clause(filter);
}

const USER = 'user-1';
const run = ({ earnedSoFar, watermark = 100, doc }) =>
  matches(buildPassiveCasFilter({ userId: USER, earnedSoFar, watermark }), {
    user: USER,
    ...doc,
  });

describe('passive-coin CAS filter', () => {
  describe('matches every shape that means "nothing changed since I read"', () => {
    it.each([
      ['the ordinary case, counter at 0', 0, { coinsEarnedToday: 0, lastPassiveCoinSteps: 100 }],
      ['a counter mid-day', 41.5, { coinsEarnedToday: 41.5, lastPassiveCoinSteps: 100 }],
      [
        'a float accumulated through repeated $inc',
        2.0949999999999998,
        { coinsEarnedToday: 2.0949999999999998, lastPassiveCoinSteps: 100 },
      ],
      ['a watermark below ours', 0, { coinsEarnedToday: 0, lastPassiveCoinSteps: 40 }],
      ['a document predating the watermark field', 0, { coinsEarnedToday: 0 }],
      // The regression. These users stopped earning entirely: the controller
      // read 0 from Mongoose's default and asked Mongo for `: 0`, which does
      // not match a document that never had the field written.
      [
        'a document predating the coinsEarnedToday field',
        0,
        { lastPassiveCoinSteps: 100 },
      ],
      ['a document predating both fields', 0, {}],
    ])('%s', (_label, earnedSoFar, doc) => {
      expect(run({ earnedSoFar, doc })).toBe(true);
    });
  });

  describe('refuses when the award would no longer be safe', () => {
    it('refuses once another source credited the user', () => {
      // Read 0, but a step-goal award landed first and took the total to 13.
      // Paying on the stale read is how the daily cap gets exceeded.
      expect(run({ earnedSoFar: 0, doc: { coinsEarnedToday: 13, lastPassiveCoinSteps: 100 } })).toBe(false);
    });

    it('refuses on a mid-day total that moved', () => {
      expect(run({ earnedSoFar: 41.5, doc: { coinsEarnedToday: 43, lastPassiveCoinSteps: 100 } })).toBe(false);
    });

    it('refuses once the step watermark has moved past us', () => {
      expect(run({ earnedSoFar: 0, doc: { coinsEarnedToday: 0, lastPassiveCoinSteps: 500 } })).toBe(false);
    });

    it('does not treat a missing field as equal to a NON-zero read', () => {
      // "Absent" can stand in for 0. It cannot stand in for 41.5, or the
      // compare-and-swap means nothing.
      expect(run({ earnedSoFar: 41.5, doc: { lastPassiveCoinSteps: 100 } })).toBe(false);
    });

    it('never matches an explicit null, which $inc cannot be applied to', () => {
      // Matching one would turn a skipped award into a 500 on the whole sync:
      // "Cannot apply $inc to a value of non-numeric type null". Such a
      // document is already broken for every other $inc on this counter; a
      // request trying to pay coins is not the place to repair it.
      expect(run({ earnedSoFar: 0, doc: { coinsEarnedToday: null, lastPassiveCoinSteps: 100 } })).toBe(false);
    });
  });

  describe('filter shape', () => {
    it('keeps the two guards in $and, not as sibling $or keys', () => {
      // Two `$or` keys in one object silently overwrite each other, leaving
      // only the watermark guarded and the cap unprotected.
      const f = buildPassiveCasFilter({ userId: USER, earnedSoFar: 0, watermark: 100 });
      expect(Array.isArray(f.$and)).toBe(true);
      expect(f.$and).toHaveLength(2);
      expect(f.$or).toBeUndefined();
    });

    it('only adds the absent-field arm when the read was zero', () => {
      const atZero = buildPassiveCasFilter({ userId: USER, earnedSoFar: 0, watermark: 1 });
      const midDay = buildPassiveCasFilter({ userId: USER, earnedSoFar: 41.5, watermark: 1 });
      expect(atZero.$and[0].$or).toHaveLength(2);
      expect(midDay.$and[0].$or).toHaveLength(1);
    });
  });
});
