// src/utils/logCoinTransaction.js
const CoinTransaction = require('../models/CoinTransaction.model');

/**
 * Log a coin transaction to the persistent CoinTransaction collection.
 * Non-blocking — errors are caught so this never breaks the main flow.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.userId
 * @param {string} params.type - 'EARNED' | 'SPENT' | 'REFUND'
 * @param {number} params.amount - Coin amount (always positive)
 * @param {number} params.balanceAfter - Balance after this transaction
 * @param {string} params.source - Source enum value
 * @param {string} params.description - Human-readable description
 * @param {Object} [params.metadata] - Optional context metadata
 */
async function logCoinTransaction({ userId, type, amount, balanceAfter, source, description, metadata }) {
  try {
    if (!amount || amount <= 0) return null;

    const transaction = await CoinTransaction.create({
      user: userId,
      type,
      amount: parseFloat(amount.toFixed(4)),
      balanceAfter: parseFloat(balanceAfter.toFixed(4)),
      source,
      description,
      metadata: metadata || {},
    });

    return transaction;
  } catch (err) {
    console.error('[logCoinTransaction] Failed:', err.message);
    return null;
  }
}

module.exports = { logCoinTransaction };
