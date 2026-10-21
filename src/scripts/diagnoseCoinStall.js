#!/usr/bin/env node
// src/scripts/diagnoseCoinStall.js
//
// ─── "Steps are going up but coins are not" — which of the causes is it? ────
//
// Read-only. One command, one answer, no queries to type.
//
// There are several unrelated reasons the balance can stop moving while steps
// keep arriving, and from the outside they look identical. Each needs a
// different fix, and guessing between them costs a deploy cycle each time:
//
//   1. the deployed build predates the fix for the CAS regression (e7c0200)
//   2. `features.stepCoinSettlement` is on, so coins are pending by design
//   3. the configured daily cap is binding — working as intended
//   4. the per-step rate is so low the coins are there but invisible
//   5. Gamification documents missing `coinsEarnedToday`, the population the
//      CAS regression actually silenced
//
// Each is checked directly and reported in plain language, with the evidence
// it was decided from, so the conclusion can be argued with rather than taken
// on trust.
//
//     node src/scripts/diagnoseCoinStall.js
//     node src/scripts/diagnoseCoinStall.js --user=someone@email.com

require('dotenv').config();
const { execSync } = require('child_process');
const mongoose = require('mongoose');

const User = require('../models/User.model');
const HealthActivity = require('../models/HealthActivity.model');
const Gamification = require('../models/Gamification.model');
const AppConfig = require('../models/AppConfig.model');
const CoinTransaction = require('../models/CoinTransaction.model');
const { getEffectiveDailyCap } = require('../utils/dailyCoinCap');
const { passiveCoinsForSteps, describePassiveCoinCap } = require('../utils/passiveCoins');
const { isStepCoinSettlementEnabled } = require('../utils/stepCoinSettlement');
const { todayISO } = require('../utils/date');
const {
  DEFAULT_RATE_PER_100_STEPS,
  DEFAULT_DAILY_EARN_LIMIT,
  DEFAULT_MAX_DAILY_REWARDS,
} = require('../constants/coinDefaults');

const arg = (n) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const h = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const num = (v) => (v == null ? '—' : Number(v).toFixed(4).replace(/\.?0+$/, ''));

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set — refusing to guess a database.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });

  const today = todayISO();
  const findings = [];

  // ── 1. Is the running code the fixed build? ───────────────────────────────
  //
  // Asked of the checkout rather than the database, because the single most
  // common reason a fix "did not work" is that it was never deployed.
  h('1. DEPLOYED BUILD');
  let head = null;
  try {
    head = execSync('git log --oneline -1', { cwd: `${__dirname}/../..`, encoding: 'utf8' }).trim();
    console.log(`  HEAD            ${head}`);
  } catch {
    console.log('  HEAD            (not a git checkout — cannot tell)');
  }

  // The fix is identifiable by its shape, not by a commit id: a checkout can
  // be rebased or squashed, but the filter either has the absent-field arm or
  // it does not.
  let hasFix = null;
  try {
    const src = require('fs').readFileSync(
      `${__dirname}/../controllers/health.controller.js`,
      'utf8',
    );
    hasFix = src.includes("{ coinsEarnedToday: { $exists: false } }");
    const hasCas = src.includes('coinsEarnedToday: gam.coinsEarnedToday');
    console.log(`  CAS fix present ${hasFix ? 'YES' : 'NO'}`);
    if (!hasFix && hasCas) {
      findings.push(
        'THE FIX IS NOT DEPLOYED. health.controller.js still has the bare-equality ' +
          'compare-and-swap. Pull and restart: coins cannot flow for affected users ' +
          'until this build is replaced.',
      );
    }
  } catch {
    console.log('  CAS fix present (could not read health.controller.js)');
  }

  // ── 2. Config ─────────────────────────────────────────────────────────────
  h('2. CONFIG');
  const cfg = (await AppConfig.findOne({ key: 'global' }).lean()) || {};
  const rate = cfg.coin_config?.steps?.rate_per_100_steps ?? DEFAULT_RATE_PER_100_STEPS;
  const stepCap = cfg.coin?.dailyEarnLimit ?? DEFAULT_DAILY_EARN_LIMIT;
  const dayCap = cfg.coin?.maxDailyRewards ?? DEFAULT_MAX_DAILY_REWARDS;
  const settling = isStepCoinSettlementEnabled(cfg);

  console.log(`  rate_per_100_steps   ${rate}`);
  console.log(`  dailyEarnLimit       ${stepCap}   (passive step coins only)`);
  console.log(`  maxDailyRewards      ${dayCap}   (overall cap, all sources)`);
  console.log(`  stepCoinSettlement   ${settling ? 'ON' : 'off'}`);
  console.log(`  ${describePassiveCoinCap(rate, stepCap).summary}`);

  if (settling) {
    findings.push(
      'features.stepCoinSettlement is ON. Step coins are NOT credited as they are ' +
        'earned — they are held as pending and paid after the day ends, by the job ' +
        'that runs at 03:30, 09:30, 15:30 and 21:30 IST. A balance that does not move ' +
        'during the day is this feature working as designed, not a bug.',
    );
  }

  // A rate this low is its own answer: 10,000 steps paying 9.5 coins looks
  // like "nothing happened" to anyone watching a rounded balance.
  const per10k = passiveCoinsForSteps(10_000, rate, stepCap);
  console.log(`  10,000 steps pays    ${num(per10k)} coins`);
  if (per10k < 1) {
    findings.push(
      `The rate pays ${num(per10k)} coins per 10,000 steps. The coins ARE moving, but ` +
        'by fractions — if the app rounds the balance for display, a full day of ' +
        'walking can look like no change at all.',
    );
  }

  // ── 3. The population the CAS regression silenced ─────────────────────────
  h('3. DOCUMENTS MISSING coinsEarnedToday');
  const totalGam = await Gamification.countDocuments({});
  const missingField = await Gamification.countDocuments({ coinsEarnedToday: { $exists: false } });
  const nullField = await Gamification.countDocuments({ coinsEarnedToday: null });
  console.log(`  gamification docs    ${totalGam}`);
  console.log(`  missing the field    ${missingField}`);
  console.log(`  explicitly null      ${nullField}`);

  if (missingField > 0 && hasFix === false) {
    findings.push(
      `${missingField} account(s) have no coinsEarnedToday field. On the UNFIXED build ` +
        'these get no passive coins at all, silently. This is the regression — deploy the fix.',
    );
  } else if (missingField === 0 && nullField === 0) {
    findings.push(
      'No account is missing coinsEarnedToday, so the CAS regression is NOT what is ' +
        'stopping coins here. Look at the config above and the per-user table below.',
    );
  }
  if (nullField > 0) {
    findings.push(
      `${nullField} account(s) have coinsEarnedToday explicitly null. $inc cannot be ` +
        'applied to null, so EVERY coin award for them fails — including the step goal. ' +
        'These need repairing: set the field to 0.',
    );
  }

  // ── 4. Today, per user ────────────────────────────────────────────────────
  h('4. TODAY, FOR THE MOST ACTIVE ACCOUNTS');
  const who = arg('user');
  let filter = { date: today, steps: { $gt: 0 } };
  if (who) {
    const u = mongoose.isValidObjectId(who)
      ? await User.findById(who).select('_id').lean()
      : await User.findOne({ email: String(who).toLowerCase().trim() }).select('_id').lean();
    if (!u) { console.error(`No user matched ${who}`); await mongoose.disconnect(); process.exit(1); }
    filter.user = u._id;
  }

  const days = await HealthActivity.find(filter)
    .sort({ steps: -1 })
    .limit(who ? 1 : 10)
    .select('user date steps bonusSteps stepCoinWatermark')
    .lean();

  if (!days.length) {
    console.log(`  No account has logged steps for ${today} yet.`);
  } else {
    const ids = days.map((d) => d.user);
    const [users, gams] = await Promise.all([
      User.find({ _id: { $in: ids } }).select('_id email emailVerified').lean(),
      Gamification.find({ user: { $in: ids } })
        .select('user coinsBalance coinsEarnedToday lastCoinDate lastPassiveCoinSteps')
        .lean(),
    ]);
    const uMap = new Map(users.map((u) => [String(u._id), u]));
    const gMap = new Map(gams.map((g) => [String(g.user), g]));

    console.log(
      `  ${'email'.padEnd(26)}${'walked'.padStart(8)}${'paidTo'.padStart(8)}` +
        `${'earnedTdy'.padStart(11)}${'balance'.padStart(10)}  state`,
    );

    let stalled = 0;
    let capped = 0;
    for (const d of days) {
      const uid = String(d.user);
      const u = uMap.get(uid) || {};
      const g = gMap.get(uid) || {};
      const walked = Math.max(0, (d.steps || 0) - (d.bonusSteps || 0));
      const paidTo = d.stepCoinWatermark ?? 0;
      const earned = g.coinsEarnedToday;
      const cap = getEffectiveDailyCap(u, dayCap, cfg.coin?.unverifiedDailyCap);

      // Owed, by the same arithmetic the live path uses.
      const owed = Math.max(
        0,
        passiveCoinsForSteps(walked, rate, stepCap) - passiveCoinsForSteps(paidTo, rate, stepCap),
      );

      let state;
      if (earned == null) { state = 'NO coinsEarnedToday FIELD'; }
      else if ((earned || 0) >= cap) { state = `cap reached (${num(earned)}/${cap})`; capped++; }
      else if (owed > 0.0001) { state = `OWED ${num(owed)} — award is being skipped`; stalled++; }
      else { state = 'up to date'; }

      console.log(
        `  ${String(u.email || uid).slice(0, 25).padEnd(26)}` +
          `${String(walked).padStart(8)}${String(paidTo).padStart(8)}` +
          `${num(earned).padStart(11)}${num(g.coinsBalance).padStart(10)}  ${state}`,
      );
    }

    if (capped > 0) {
      findings.push(
        `${capped} of the accounts above have hit maxDailyRewards (${dayCap}). For them the ` +
          'balance SHOULD stop — that is the cap doing its job. Raise maxDailyRewards if ' +
          'the limit is lower than intended.',
      );
    }
    if (stalled > 0) {
      findings.push(
        `${stalled} of the accounts above are owed coins their watermark says were never ` +
          'paid. If the fix IS deployed, run: npm run backfill:step-coins -- --days=7',
      );
    }
  }

  // ── 5. Pending coins ──────────────────────────────────────────────────────
  h('5. PENDING / RECENT LEDGER');
  try {
    const PendingCoin = require('../models/PendingCoin.model');
    const pending = await PendingCoin.countDocuments({ status: 'pending' });
    console.log(`  pending awards       ${pending}`);
    if (pending > 0) {
      findings.push(
        `${pending} award(s) are sitting in PendingCoin. These are earned but unpaid until ` +
          'the settlement job runs. If they are stuck, run: POST /cron/settle-step-coins',
      );
    }
  } catch {
    console.log('  pending awards       (PendingCoin model not present)');
  }

  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const recent = await CoinTransaction.countDocuments({
    createdAt: { $gte: since },
    source: { $in: ['PASSIVE_STEPS', 'PASSIVE_STEPS_RETRO'] },
  });
  console.log(`  step-coin ledger rows in the last 24h   ${recent}`);
  if (recent === 0) {
    findings.push(
      'NOT ONE step-coin ledger row was written in the last 24 hours. Coins are not being ' +
        'paid at all — this is not a display problem.',
    );
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  h('WHAT THIS MEANS');
  if (!findings.length) {
    console.log('  Nothing anomalous found. Coins appear to be flowing normally.');
  } else {
    findings.forEach((f, i) => {
      console.log(`\n  ${i + 1}. ${f.replace(/(.{1,86})(\s|$)/g, '$1\n     ').trim()}`);
    });
  }
  console.log('');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
