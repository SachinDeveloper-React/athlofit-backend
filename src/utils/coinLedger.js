// src/utils/coinLedger.js
//
// ─── Keeping the ledger's running balance true ──────────────────────────────
//
// Every CoinTransaction row carries `balanceAfter`, the balance as it stood
// once that row was applied. The admin ledger shows it as its Balance column
// and it is the first thing anyone reads. It is written once, at the time of
// the transaction, and nothing maintained it afterwards — so the moment a
// reversal removed rows from the middle of the history, every later row kept
// saying a balance that no longer existed, and the newest row disagreed with
// the account by hundreds of coins.
//
// This rewrites the column as a chain anchored on the account's ACTUAL
// balance: the newest row is set to the balance, and each earlier row to what
// the balance must have been before the row after it. Anchored at the end
// rather than the start because the end is what people look at — the newest
// rows always agree with the account — and because the history was never
// exact at the start anyway: awards that failed to log leave a small gap
// that a start-anchored chain would carry forward to the top of the screen.
// Anchored at the end, that gap sits where it happened, in the oldest rows.
//
// It changes no amounts and no balances. It is bookkeeping for a display
// column, run after anything that removes or restores rows.

const CoinTransaction = require('../models/CoinTransaction.model');
const Gamification = require('../models/Gamification.model');

const round4 = v => parseFloat(Number(v || 0).toFixed(4));
const signOf = t => (t.type === 'SPENT' || t.type === 'DEDUCTED' ? -1 : 1);

/**
 * Rewrites `balanceAfter` on every row of one account so the chain ends at
 * the account's current balance.
 *
 * @param {any} userId
 * @returns {Promise<{ rows: number, changed: number, opening: number }>}
 *   `opening` is what the chain implies the balance was before the first row.
 */
async function rechainBalances(userId) {
  const gam = await Gamification.findOne({ user: userId }).select('coinsBalance').lean();
  const rows = await CoinTransaction.find({ user: userId })
    .sort({ createdAt: 1, _id: 1 })
    .select('type amount balanceAfter')
    .lean();

  let running = round4(gam?.coinsBalance);
  const ops = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const t = rows[i];
    if (Math.abs(round4(t.balanceAfter) - running) > 0.0005) {
      ops.push({ updateOne: { filter: { _id: t._id }, update: { $set: { balanceAfter: running } } } });
    }
    running = round4(running - signOf(t) * (Number(t.amount) || 0));
  }
  if (ops.length) await CoinTransaction.bulkWrite(ops, { ordered: false });
  return { rows: rows.length, changed: ops.length, opening: running };
}

module.exports = { rechainBalances };
