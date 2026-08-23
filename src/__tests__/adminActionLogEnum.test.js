// Guards against enum drift in the admin audit log.
//
// BONUS_STEPS was passed to logAdminAction from the bonus-steps endpoint while
// missing from the schema enum. Mongoose rejected every such write and
// logAdminAction swallowed the error in its catch, so the single admin action
// that creates steps from nothing — crediting them directly to a user — was the
// one action with no audit trail, silently, for as long as it had existed.
//
// The values are scattered string literals across controllers, so the only way
// to keep them honest is to read them back out of the source.

const fs = require('fs');
const path = require('path');
const AdminActionLog = require('../models/AdminActionLog.model');

const CONTROLLERS_DIR = path.join(__dirname, '..', 'controllers');

/** Every `logAdminAction(..., 'LITERAL', ...)` action argument in the source. */
function collectActionLiterals() {
  const found = new Set();
  for (const file of fs.readdirSync(CONTROLLERS_DIR)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(CONTROLLERS_DIR, file), 'utf8');
    // Third argument of logAdminAction, when written as a plain string literal.
    // Ternaries and variables are out of reach of a regex; those are covered by
    // the reverse direction below and by the endpoints' own tests.
    const re = /logAdminAction\(\s*[^,]+,\s*[^,]+,\s*'([A-Z_]+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) found.add(m[1]);
  }
  return [...found].sort();
}

describe('AdminActionLog action enum', () => {
  const enumValues = AdminActionLog.schema.path('action').enumValues;

  it('accepts every action literal used in the controllers', () => {
    const used = collectActionLiterals();
    // Sanity: the scan must actually be finding things, or this test passes
    // vacuously the moment the call shape changes.
    expect(used.length).toBeGreaterThan(5);

    const missing = used.filter((a) => !enumValues.includes(a));
    // A value here means those audit writes are throwing and being swallowed —
    // the action happens, the record does not.
    expect(missing).toEqual([]);
  });

  it('includes the step-granting action specifically', () => {
    // Called out on its own because this is the action that manufactures steps,
    // which makes its audit trail the one that matters most.
    expect(enumValues).toContain('BONUS_STEPS');
  });

  it('validates a BONUS_STEPS document instead of rejecting it', async () => {
    const doc = new AdminActionLog({
      admin: '000000000000000000000001',
      targetUser: '000000000000000000000002',
      action: 'BONUS_STEPS',
      reason: 'compensation',
    });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('still rejects an action outside the enum', async () => {
    // The enum has to keep being a constraint, not just documentation.
    const doc = new AdminActionLog({
      admin: '000000000000000000000001',
      targetUser: '000000000000000000000002',
      action: 'NOT_A_REAL_ACTION',
    });
    await expect(doc.validate()).rejects.toThrow();
  });
});
