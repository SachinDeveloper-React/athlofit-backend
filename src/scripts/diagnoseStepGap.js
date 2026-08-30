#!/usr/bin/env node
// src/scripts/diagnoseStepGap.js
//
// ─── Why a user's steps went missing for a stretch of days ───────────────────
//
// Read-only. Answers the question that took a full manual investigation last
// time: "this user had steps on the 25th, nothing until the 29th, then 17,749
// in one go — what happened?"
//
// The answer is never in one collection, which is why this exists. It joins the
// four places the story is split across, per date:
//
//   HealthActivity  — was a row written for that day at all, and by which build
//   CoinTransaction — what was actually paid, same-day or retroactively
//   SyncLog         — what the DEVICE sent and what validation did to it
//   Gamification    — the watermarks that decide what "new steps" means
//
// ── The key fact that narrows it down ────────────────────────────────────────
//
// Both clients back-fill SEVEN days on every run (HealthSyncHelper.kt and
// backgroundSync.service.ts), and the server's retroactive award window is also
// seven days. But both clients skip any day whose step count is zero — they do
// not POST it at all.
//
// So a day with NO HealthActivity row and NO SyncLog row was not "missed by a
// sync that never ran". Later syncs did come back for it, within the window,
// and read zero from Health Connect. That is a device-side data question, not a
// scheduling one, and it is what the verdicts below are built to separate.
//
// ── Read this soon after the incident ────────────────────────────────────────
//
// SyncLog has a 7-day TTL (SyncLog.model.js). Past that the "what did the device
// send" column is gone for good, and only HealthActivity and the ledger remain.
// For an ongoing case, switch on verbose tracing first so the next few days are
// captured in full:
//
//     POST /admin/users/:id/sync-debug  { "enabled": true, "hours": 48 }
//
// Usage:
//     node src/scripts/diagnoseStepGap.js <email|userId> [fromDate] [toDate]
//     node src/scripts/diagnoseStepGap.js user@example.com 2026-08-23 2026-08-30
//
// Dates are ISO "YYYY-MM-DD" and default to the last 10 days.

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User.model');
const HealthActivity = require('../models/HealthActivity.model');
const CoinTransaction = require('../models/CoinTransaction.model');
const SyncLog = require('../models/SyncLog.model');
const Gamification = require('../models/Gamification.model');
const AppConfig = require('../models/AppConfig.model');
const { checkStepSyncVersion } = require('../utils/versionGate');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function datesBetween(from, to) {
  const out = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    out.push(isoDate(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function pad(value, width) {
  const s = String(value ?? '');
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

/**
 * What happened on this date, in one line, ordered so the most specific
 * explanation wins rather than whichever check happened to run first.
 */
function verdictFor({ activity, syncLogs, sameDayCoins, retroCoins }) {
  const rejected = syncLogs.filter(l => l.logReason === 'rejected');
  if (rejected.length) {
    const why = rejected[0].reason || 'rejected';
    return `REJECTED by server — ${why} (${rejected.length} attempt(s))`;
  }

  if (!activity && !syncLogs.length) {
    // The important verdict. Later syncs did revisit this date and found
    // nothing worth posting.
    return 'NO DATA — device never posted this day (Health Connect read 0 or unavailable)';
  }

  if (!activity && syncLogs.length) {
    return 'ANOMALY — device posted but no HealthActivity row exists';
  }

  if (!activity.steps) {
    // The app reached the server and wrote a row — a hydration or vitals post
    // does exactly this — but had no steps to send. Very different from silence.
    return 'APP ALIVE but sent no steps (row written by a hydration/vitals sync)';
  }

  const clamped = syncLogs.filter(l => l.severity !== 'none');
  const parts = [];
  parts.push(`${activity.steps} steps`);
  if (activity.bonusSteps) parts.push(`(${activity.bonusSteps} bonus)`);
  if (!sameDayCoins && !retroCoins) parts.push('NO COINS PAID');
  if (retroCoins) parts.push('paid retroactively');
  if (clamped.length) {
    parts.push(`CLAMPED x${clamped.length}: ${clamped[0].reason || clamped[0].severity}`);
  }
  return parts.join(' · ');
}

async function main() {
  const [identifier, fromArg, toArg] = process.argv.slice(2);

  if (!identifier) {
    console.error(
      'Usage: node src/scripts/diagnoseStepGap.js <email|userId> [fromDate] [toDate]',
    );
    process.exit(1);
  }
  for (const [label, value] of [['fromDate', fromArg], ['toDate', toArg]]) {
    if (value && !ISO_DATE_RE.test(value)) {
      console.error(`${label} must be ISO YYYY-MM-DD, got "${value}"`);
      process.exit(1);
    }
  }

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is not set — refusing to guess a database.');
    process.exit(1);
  }
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 });

  const query = mongoose.isValidObjectId(identifier)
    ? { _id: identifier }
    : { email: String(identifier).toLowerCase().trim() };

  const user = await User.findOne(query)
    .select(
      'name email emailVerified dailyStepGoal createdAt coinBlockedUntil ' +
        'stepsTracking syncDebug device deviceHistory',
    )
    .lean();

  if (!user) {
    console.error(`No user matched ${identifier}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const to = toArg || isoDate(new Date());
  const defaultFrom = new Date(`${to}T00:00:00Z`);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 9);
  const from = fromArg || isoDate(defaultFrom);
  const dates = datesBetween(from, to);

  const [activities, transactions, syncLogs, gam, cfg] = await Promise.all([
    HealthActivity.find({ user: user._id, date: { $gte: from, $lte: to } }).lean(),
    CoinTransaction.find({
      user: user._id,
      'metadata.date': { $gte: from, $lte: to },
    })
      .sort({ createdAt: 1 })
      .lean(),
    SyncLog.find({ user: user._id, date: { $gte: from, $lte: to } })
      .sort({ createdAt: 1 })
      .lean(),
    Gamification.findOne({ user: user._id }).lean(),
    AppConfig.findOne({ key: 'global' }).lean(),
  ]);

  const byDate = (list, key = 'date') => {
    const map = new Map();
    for (const item of list) {
      const d = key === 'date' ? item.date : item.metadata?.date;
      if (!d) continue;
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(item);
    }
    return map;
  };

  const activityByDate = new Map(activities.map(a => [a.date, a]));
  const logsByDate = byDate(syncLogs);
  const txByDate = byDate(transactions, 'metadata.date');

  // ── Account context ───────────────────────────────────────────────────────
  console.log('\n═══ ACCOUNT ═══');
  console.log(`  ${user.name || '(no name)'} <${user.email}>  id=${user._id}`);
  console.log(`  created         ${isoDate(new Date(user.createdAt))}`);
  console.log(`  emailVerified   ${user.emailVerified}`);
  console.log(`  dailyStepGoal   ${user.dailyStepGoal}`);
  console.log(
    `  stepsTracking   ${user.stepsTracking?.enabled !== false ? 'enabled' : 'DISABLED BY ADMIN'}`,
  );
  const blocked =
    user.coinBlockedUntil && new Date(user.coinBlockedUntil) > new Date();
  console.log(`  coinBlocked     ${blocked ? `until ${user.coinBlockedUntil}` : 'no'}`);

  const tracing =
    user.syncDebug?.enabled === true &&
    (!user.syncDebug.expiresAt || new Date(user.syncDebug.expiresAt) > new Date());
  console.log(
    `  syncDebug       ${tracing ? `ON until ${user.syncDebug.expiresAt}` : 'off'}` +
      (tracing ? '' : '  ← switch on to capture full traces from here forward'),
  );

  // ── Would this build be refused right now? ────────────────────────────────
  const gate = checkStepSyncVersion(cfg, {
    appVersion: user.device?.appVersion || null,
  });
  console.log(
    `  build gate      ${gate.blocked ? `BLOCKED (${gate.rule}) — this is very likely the cause` : 'allowed'}` +
      `  [app ${user.device?.appVersion || 'unknown'}]`,
  );

  if (user.deviceHistory?.length) {
    console.log('  build changes:');
    for (const h of user.deviceHistory.slice(-6)) {
      console.log(
        `    ${h.at ? new Date(h.at).toISOString().slice(0, 16) : '?'}  ` +
          `${h.appVersion || '?'} (${h.buildNumber ?? '?'})`,
      );
    }
  }

  // ── Per-day table ─────────────────────────────────────────────────────────
  console.log('\n═══ PER-DAY ═══');
  console.log(
    `  ${pad('DATE', 12)}${pad('ROW', 5)}${pad('SYNCS', 7)}${pad('BUILD', 12)}VERDICT`,
  );

  const gaps = [];
  const aliveButNoSteps = [];
  let sawTelemetry = false;
  for (const date of dates) {
    const activity = activityByDate.get(date);
    const logs = logsByDate.get(date) || [];
    const txs = txByDate.get(date) || [];
    const sameDayCoins = txs.filter(t => !String(t.source).endsWith('_RETRO'));
    const retroCoins = txs.filter(t => String(t.source).endsWith('_RETRO'));

    const verdict = verdictFor({
      activity,
      syncLogs: logs,
      sameDayCoins: sameDayCoins.length,
      retroCoins: retroCoins.length,
    });
    if (!activity && !logs.length) gaps.push(date);
    if (activity && !activity.steps) aliveButNoSteps.push(date);
    if (
      activity?.syncVersions?.length ||
      activity?.lastSync?.appVersion ||
      txs.some(t => t.metadata?.appVersion) ||
      logs.some(l => l.appVersion)
    ) {
      sawTelemetry = true;
    }

    const build =
      activity?.syncVersions?.join(',') || activity?.lastSync?.appVersion || '—';

    console.log(
      `  ${pad(date, 12)}${pad(activity ? 'yes' : '—', 5)}${pad(logs.length || '—', 7)}` +
        `${pad(build, 12)}${verdict}`,
    );

    for (const t of txs) {
      console.log(
        `  ${' '.repeat(12)}└─ ${pad(t.source, 22)} ${String(t.amount).padStart(9)} coins  ` +
          `${new Date(t.createdAt).toISOString().slice(0, 16)}  ` +
          `[app ${t.metadata?.appVersion || '?'} / ${t.metadata?.clientSource || '?'}]`,
      );
    }
    for (const l of logs) {
      if (l.logReason === 'trace') continue; // verbose rows: only on request
      console.log(
        `  ${' '.repeat(12)}└─ SYNC ${pad(l.logReason, 12)} ` +
          `sent=${l.incomingSteps} kept=${l.clampedSteps} stored=${l.storedSteps}` +
          `${l.reason ? ` — ${l.reason}` : ''}`,
      );
    }
  }

  // ── Current watermarks ────────────────────────────────────────────────────
  console.log('\n═══ GAMIFICATION (current state, not per-day) ═══');
  console.log(`  coinsBalance          ${gam?.coinsBalance}`);
  console.log(`  coinsEarnedToday      ${gam?.coinsEarnedToday}`);
  console.log(`  lastCoinDate          ${gam?.lastCoinDate}`);
  console.log(`  lastPassiveCoinSteps  ${gam?.lastPassiveCoinSteps}`);
  console.log(`  stepGoalCoinDate      ${gam?.stepGoalCoinDate}`);
  console.log(`  stepGoalNotifiedDate  ${gam?.stepGoalNotifiedDate ?? '(field not set)'}`);

  // ── What to do next ───────────────────────────────────────────────────────
  console.log('\n═══ READ THIS ═══');

  if (!sawTelemetry) {
    console.log('  ⚠ NO BUILD TELEMETRY ON ANY ROW IN THIS RANGE.');
    console.log('    Every transaction and row shows app "?" — this device has never');
    console.log('    sent version headers, so it is running a build from before that');
    console.log('    shipped. Two consequences:');
    console.log('      · Which code path posted (app / native_service / worker) is');
    console.log('        unknowable for this user, so the verdicts below cannot be');
    console.log('        narrowed as far as they otherwise would.');
    console.log('      · Any step-reading fix shipped since then is NOT on this device.');
    console.log('    Confirm what they are actually running before debugging further.');
    console.log('');
  }

  if (aliveButNoSteps.length) {
    console.log(`  App reached the server but sent NO steps on: ${aliveButNoSteps.join(', ')}`);
    console.log('    This is the strongest signal here. The app was running, scheduled,');
    console.log('    authenticated and writing rows — it simply had no step data. That');
    console.log('    rules out force-stop / battery-killer / gating as the cause, and');
    console.log('    points squarely at the device-side step read returning nothing.');
    console.log('');
  }

  if (!gaps.length) {
    console.log('  No fully-silent days in this range.');
  } else {
    console.log(`  Silent days (no row, no sync attempt): ${gaps.join(', ')}`);
    console.log('');
    console.log('  Both clients revisit the last 7 days on every run and skip any day');
    console.log('  reading 0 steps, so these days WERE revisited and came back empty.');
    console.log('  That points at the device, not the schedule. In order of likelihood:');
    console.log('');
    if (aliveButNoSteps.length) {
      console.log('    (The app-alive day above already rules out the app not running.)');
      console.log('');
    }
    console.log('    1. Health Connect permission revoked or the step source removed —');
    console.log('       the read returns unavailable, which the client treats as "skip",');
    console.log('       so nothing is posted. Check permissions on the device first.');
    console.log('    2. No Health Connect step writer active (no Google Fit / Samsung');
    console.log('       Health), so steps only exist while our own foreground service');
    console.log('       runs — and it was killed. Check whether the days that DO have');
    console.log('       data came from clientSource "native_service".');
    console.log('    3. A single multi-day StepsRecord: the midnight-bleed filter in');
    console.log('       healthConnect.service.ts drops any record starting before the');
    console.log('       window, so every day after the first reads 0. Confirm on the');
    console.log('       device via the Step Sources debug screen (per-origin totals).');
    console.log('');
    console.log('  If a build gate shows BLOCKED above, stop — that is the answer, and');
    console.log('  the silent days are simply days the client was refused.');
  }
  console.log('');
  console.log('  SyncLog rows expire after 7 days. Capture this output now, and switch');
  console.log('  on tracing to catch the next occurrence in full:');
  console.log(`    POST /admin/users/${user._id}/sync-debug  { "enabled": true, "hours": 48 }`);
  console.log('');

  await mongoose.disconnect();
}

main().catch(async err => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
