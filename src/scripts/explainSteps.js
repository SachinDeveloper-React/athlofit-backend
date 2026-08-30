#!/usr/bin/env node
// src/scripts/explainSteps.js
//
// ─── Where every one of a user's steps came from ─────────────────────────────
//
// Read-only. The companion to diagnoseStepGap.js, which answers "why are steps
// MISSING". This answers the opposite question:
//
//   "17,000 steps landed in a single sync. Were they walked that day, or is it a
//    backlog from the days the phone was offline — and which app on the phone
//    counted them?"
//
// Both halves used to be unanswerable. A day was one number, so a jump was just
// a bigger number, and the sync payload carried only `steps` — none of the
// per-origin detail the client had already computed. StepProvenance keeps that
// now, and this prints it.
//
// ── How to read the output ───────────────────────────────────────────────────
//
// Three things, in the order you want them:
//
//   1. The ledger — one line per accepted increase, largest first. A 17,000 row
//      says which reader produced it, which Health Connect origins contributed,
//      what clock hours the underlying records cover, and how many days late it
//      was delivered.
//
//   2. Attribution — per origin, what it REPORTED next to what it CONTRIBUTED.
//      When they differ, that origin was judged a mirror of another: its steps
//      were seen and deliberately not double-counted. That gap is the answer to
//      most "my steps are missing" reports.
//
//   3. The hour histogram — when the steps were RECORDED, as opposed to when
//      they arrived. This is what separates a real day's walking delivered late
//      (spread across many hours) from a bulk record that appeared all at once.
//
// ── Two dates, never confuse them ───────────────────────────────────────────
//
// `date` is the day the steps BELONG to. `at` is when the server accepted them.
// A backlog flushed after a week offline has a normal `date` and a very late
// `at`, and looks alarming in any view that only shows one of them.
//
// Provenance is only recorded for syncs from a build that reports its source, so
// an empty result for an old build means "not recorded", not "no steps".
//
// Usage:
//     node src/scripts/explainSteps.js <email|userId> [date] [--all]
//     node src/scripts/explainSteps.js user@example.com 2026-08-28
//     node src/scripts/explainSteps.js user@example.com            # last 7 days
//
// --all shows every increase. Without it, increases under 100 steps are folded
// into a count, because a day is mostly ordinary quarter-hourly deltas and the
// question is almost never about those.

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User.model');
const HealthActivity = require('../models/HealthActivity.model');
const StepProvenance = require('../models/StepProvenance.model');
const { describeEntry } = require('../utils/stepProvenance');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Below this, an increase is ordinary. Folded away unless --all is passed. */
const SMALL_INCREASE = 100;

const n = (v) => Number(v || 0).toLocaleString('en-US');

function pad(value, width) {
  const s = String(value ?? '');
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

/** Local clock time of an instant, in the timezone the device reported. */
function localTime(instant, timezone) {
  if (!instant) return '--:--';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone || 'UTC',
    }).format(new Date(instant));
  } catch {
    // An unparseable timezone from a device must not take the whole report down.
    return new Date(instant).toISOString().slice(11, 16);
  }
}

/**
 * The hour histogram as a sparkline, so the SHAPE of a day is visible at a
 * glance. Shape is the point: a jump spread over fifteen hours and a jump
 * inside one hour are the same total and completely different events.
 */
function sparkline(hourly) {
  if (!hourly?.length || !hourly.some((h) => h > 0)) return null;
  const blocks = ' ▁▂▃▄▅▆▇█';
  const max = Math.max(...hourly);
  return hourly
    .map((h) => blocks[Math.min(8, Math.ceil((h / max) * 8))])
    .join('');
}

/**
 * The headline for a day: what a reader should conclude before reading rows.
 *
 * Ordered so the most specific explanation wins, rather than whichever check
 * happens to run first — the same rule diagnoseStepGap.js uses for its verdicts.
 */
function verdictFor(day) {
  const entries = day.entries || [];
  if (!entries.length) return 'No increases recorded for this day.';

  const backfilled = entries.filter((e) => e.daysLate > 0);
  const backfilledSteps = backfilled.reduce((sum, e) => sum + e.delta, 0);
  const biggest = entries.reduce((max, e) => (e.delta > max.delta ? e : max), entries[0]);

  const parts = [];

  if (backfilledSteps > 0) {
    const maxLate = Math.max(...backfilled.map((e) => e.daysLate));
    parts.push(
      `${n(backfilledSteps)} of ${n(day.walkedSteps)} steps were delivered up to ` +
      `${maxLate} day(s) after this date — a backlog, not steps walked on the day they arrived.`,
    );
  }

  if (biggest.delta >= 3000) {
    const hours =
      biggest.recordedFrom && biggest.recordedTo
        ? (new Date(biggest.recordedTo) - new Date(biggest.recordedFrom)) / 3_600_000
        : null;
    if (hours !== null && hours >= 2) {
      parts.push(
        `The largest single jump (${n(biggest.delta)}) covers ${hours.toFixed(1)}h of ` +
        `recordings across ${biggest.recordCount} record(s) — consistent with real walking ` +
        `delivered in one sync.`,
      );
    } else if (hours !== null) {
      // The shape that is worth a second look: a large figure with almost no
      // recording time behind it.
      parts.push(
        `⚠ The largest single jump (${n(biggest.delta)}) spans only ${hours.toFixed(1)}h ` +
        `across ${biggest.recordCount} record(s). A five-figure count inside a short window ` +
        `is not walking — check the origin below.`,
      );
    } else {
      parts.push(
        `The largest single jump is ${n(biggest.delta)}, from a reader that supplies no ` +
        `record timestamps (${biggest.reader}), so its recording window cannot be checked.`,
      );
    }
  }

  if (!parts.length) {
    parts.push(`${entries.length} ordinary increases, nothing unusual.`);
  }
  return parts.join('\n           ');
}

async function main() {
  const args = process.argv.slice(2);
  const showAll = args.includes('--all');
  const [identifier, dateArg] = args.filter((a) => a !== '--all');

  if (!identifier) {
    console.error(
      'Usage: node src/scripts/explainSteps.js <email|userId> [YYYY-MM-DD] [--all]',
    );
    process.exit(1);
  }
  if (dateArg && !ISO_DATE_RE.test(dateArg)) {
    console.error(`date must be ISO YYYY-MM-DD, got "${dateArg}"`);
    process.exit(1);
  }

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is not set — refusing to guess a database.');
    process.exit(1);
  }
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 });

  const query = mongoose.isValidObjectId(identifier)
    ? { _id: identifier }
    : { email: String(identifier).toLowerCase() };
  const user = await User.findOne(query).select('_id name email device').lean();

  if (!user) {
    console.error(`No user matched "${identifier}"`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const filter = { user: user._id };
  if (dateArg) filter.date = dateArg;

  const days = await StepProvenance.find(filter)
    .sort({ date: -1 })
    .limit(dateArg ? 1 : 7)
    .lean();

  console.log('');
  console.log(`  User    ${user.name || '(no name)'}  <${user.email}>`);
  console.log(`  Id      ${user._id}`);
  console.log(`  Build   ${user.device?.appVersion || 'unknown'} (${user.device?.lastSource || 'unknown'})`);
  console.log('');

  if (!days.length) {
    console.log('  No step attribution recorded for this user/date.');
    console.log('');
    console.log('  Attribution is written only for syncs from a build that reports its');
    console.log('  step source, and only when walked steps actually increased. An empty');
    console.log('  result therefore means "not recorded", NOT "no steps walked" — check');
    console.log('  HealthActivity for the totals, and diagnoseStepGap.js for why a day');
    console.log('  might be missing entirely.');
    console.log('');
    await mongoose.disconnect();
    return;
  }

  for (const day of days) {
    const activity = await HealthActivity.findOne({ user: user._id, date: day.date })
      .select('steps bonusSteps')
      .lean();

    console.log('  ' + '─'.repeat(76));
    console.log(`  ${day.date}   ${n(day.walkedSteps)} walked + ${n(day.bonusSteps)} bonus = ${n(day.totalSteps)}`);
    if (activity && activity.steps !== day.totalSteps) {
      // The ledger and the stored day disagreeing is itself a finding: the day
      // was written by something that does not go through this path (an admin
      // bonus, a migration), or a write was lost.
      console.log(`  ⚠ HealthActivity holds ${n(activity.steps)} — the ledger and the stored day disagree.`);
    }
    console.log(`  Readers ${(day.readers || []).join(', ') || 'none'}   Timezone ${day.timezone || 'unknown'}`);
    console.log(`  Synced  ${day.firstSyncAt ? new Date(day.firstSyncAt).toISOString() : '?'} → ${day.lastSyncAt ? new Date(day.lastSyncAt).toISOString() : '?'}`);
    console.log('');
    console.log(`  VERDICT  ${verdictFor(day)}`);
    console.log('');

    // ── Attribution ─────────────────────────────────────────────────────────
    if (day.origins?.length) {
      console.log('  Where the steps came from');
      console.log(`    ${pad('origin', 42)}${pad('reported', 11)}${pad('counted', 11)}verdict`);
      for (const o of day.origins) {
        const mirrored = o.contributed === 0 && o.steps > 0;
        console.log(
          `    ${pad(o.packageName, 42)}${pad(n(o.steps), 11)}${pad(n(o.contributed), 11)}` +
          (mirrored
            ? `duplicate of another source — NOT counted`
            : `counted (${Math.round((o.disjointFraction || 0) * 100)}% independent)`),
        );
      }
      console.log('');
    }

    // ── Shape of the day ────────────────────────────────────────────────────
    const spark = sparkline(day.hourly);
    if (spark) {
      console.log('  When they were RECORDED (local hours, not when they arrived)');
      console.log(`    00${' '.repeat(4)}06${' '.repeat(4)}12${' '.repeat(4)}18${' '.repeat(3)}23`);
      console.log(`    ${spark}`);
      const busiest = day.hourly.indexOf(Math.max(...day.hourly));
      console.log(`    busiest hour ${String(busiest).padStart(2, '0')}:00 with ${n(day.hourly[busiest])} steps`);
      console.log('');
    }

    // ── The ledger ──────────────────────────────────────────────────────────
    const entries = (day.entries || []).slice().sort((a, b) => b.delta - a.delta);
    const shown = showAll ? entries : entries.filter((e) => e.delta >= SMALL_INCREASE);
    const hidden = entries.length - shown.length;

    console.log(`  Increases (${entries.length} recorded${day.droppedEntries ? `, ${day.droppedEntries} dropped past the cap` : ''})`);
    for (const e of shown) {
      const when = localTime(e.at, day.timezone);
      console.log(`    ${when}  ${pad(`+${n(e.delta)}`, 10)}${describeEntry(e)}`);
    }
    if (hidden > 0) {
      console.log(`    … and ${hidden} increase(s) under ${SMALL_INCREASE} steps. Pass --all to list them.`);
    }
    console.log('');
  }

  console.log('  ' + '─'.repeat(76));
  console.log('  Attribution expires after 90 days. For what a device SENT versus what');
  console.log('  the server kept (7-day window), use:');
  console.log(`    GET /admin/users/${user._id}/sync-logs`);
  console.log('  For days with no steps at all, use diagnoseStepGap.js instead.');
  console.log('');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
