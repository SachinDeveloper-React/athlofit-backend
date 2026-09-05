#!/usr/bin/env node
/**
 * set-force-update.js
 *
 * Inspects and sets the update gate (AppConfig.forceUpdate) that drives
 * GET /config/check-version and the app's ForceUpdateModal.
 *
 * Why this exists rather than a hand-written PATCH:
 *
 *   • The stored values were in the wrong numbering scheme and nobody could
 *     see it. android held minVersion/latestVersion '0.0.77' — the package.json
 *     version — while every Android client reports its versionName, '1.77'.
 *     compareVersions('1.77', '0.0.77') is 1, so every client on every build
 *     compared as NEWER than the configured latest and no prompt ever fired.
 *     A gate that silently answers "no update" looks exactly like a gate that
 *     was never meant to fire.
 *
 *   • A wrong value in the other direction is worse. `force` has no dismiss in
 *     the app, so setting minVersion above the build people actually have
 *     leaves them in a modal they cannot dismiss, in an app they cannot use,
 *     with no client-side way to recover. That is a support incident reaching
 *     the whole install base from one write.
 *
 * So this prints what a client would actually be told — through
 * resolveUpdateRequirement, the same function the endpoint calls, never a
 * second copy of the logic — before anything is written.
 *
 * The versions here must be the versions DEVICES REPORT, which is
 * android/app/build.gradle `versionName` on Android (currently 1.77) and
 * MARKETING_VERSION / CFBundleShortVersionString on iOS. It is not the
 * package.json version, and the two do not track each other.
 *
 * Dry run by default; nothing is written without --apply.
 *
 *   node scripts/set-force-update.js
 *       Show what is stored and what each platform's clients are being told.
 *
 *   node scripts/set-force-update.js --platform android --min 1.77 --latest 1.78
 *       Preview that change — stored values, resulting values, and the verdict
 *       every probed version would receive.
 *
 *   node scripts/set-force-update.js --platform android --min 1.77 --latest 1.78 --apply
 *       Write it.
 *
 * Other flags:
 *   --url <store url>     set that platform's updateUrl
 *   --enabled true|false  master switch for the whole gate
 *   --probe 1.76,1.77     extra versions to show verdicts for
 */

require('dotenv').config();
const mongoose = require('mongoose');
const AppConfig = require('../src/models/AppConfig.model');
const {
  resolveUpdateRequirement,
  compareVersions,
} = require('../src/utils/versionGate');

// ─── Args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : null;
};

const platform = (flag('platform') || '').toLowerCase();
const newMin = flag('min');
const newLatest = flag('latest');
const newUrl = flag('url');
const newEnabled = flag('enabled');
const extraProbes = (flag('probe') || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const VERSION_RE = /^\d+(\.\d+)*$/;

/** The version one patch below `v`, for probing "does the build below the floor
 *  actually get forced?". Returns null when there is nothing below it. */
function oneBelow(v) {
  const parts = String(v).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] > 0) {
      parts[i] -= 1;
      return parts.join('.');
    }
  }
  return null;
}

function describe(cfg, platformName) {
  const p = cfg.forceUpdate?.[platformName] || {};
  return {
    minVersion: p.minVersion || '(unset)',
    latestVersion: p.latestVersion || '(unset)',
    updateUrl: p.updateUrl || '(unset)',
  };
}

/** Print the verdict each probed version would receive, using the real decision
 *  function so the preview cannot drift from what the endpoint answers. */
function previewVerdicts(forceUpdateCfg, platformName, probes) {
  const seen = new Set();
  for (const version of probes) {
    if (!version || seen.has(version) || !VERSION_RE.test(version)) continue;
    seen.add(version);
    const v = resolveUpdateRequirement(forceUpdateCfg, platformName, version);
    const label =
      v.updateType === 'force'
        ? 'FORCE  — modal cannot be dismissed'
        : v.updateType === 'soft'
          ? 'soft   — dismissible "Later"'
          : 'none   — no prompt';
    console.log(`     client ${version.padEnd(8)} → ${label}`);
  }
}

async function main() {
  // Arguments first, so a typo is caught without needing a database at all.
  if (platform && !['android', 'ios'].includes(platform)) {
    console.error(`❌ --platform must be 'android' or 'ios', got '${platform}'`);
    process.exit(1);
  }
  if ((newMin || newLatest || newUrl) && !platform) {
    console.error('❌ --min / --latest / --url need --platform android|ios');
    process.exit(1);
  }
  for (const [name, value] of [['min', newMin], ['latest', newLatest]]) {
    if (value && !VERSION_RE.test(value)) {
      console.error(
        `❌ --${name} must be a dotted numeric version (e.g. 1.78), got '${value}'`,
      );
      process.exit(1);
    }
  }

  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const cfg = await AppConfig.findOne({ key: 'global' });
  if (!cfg) {
    console.error('❌ No AppConfig document with key "global".');
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(
    `Update gate — ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`,
  );
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  enabled: ${cfg.forceUpdate?.enabled ?? true}`);
  for (const p of ['android', 'ios']) {
    const d = describe(cfg, p);
    console.log(`\n  ${p}`);
    console.log(`     minVersion   : ${d.minVersion}`);
    console.log(`     latestVersion: ${d.latestVersion}`);
    console.log(`     updateUrl    : ${d.updateUrl}`);
    console.log('     currently answering:');
    previewVerdicts(cfg.forceUpdate, p, [
      cfg.forceUpdate?.[p]?.latestVersion,
      cfg.forceUpdate?.[p]?.minVersion,
      oneBelow(cfg.forceUpdate?.[p]?.minVersion || ''),
      ...extraProbes,
    ]);
  }

  // ── Nothing to change: this was an inspection run ──────────────────────────
  if (!newMin && !newLatest && !newUrl && newEnabled === null) {
    console.log(
      '\nNo changes requested. Pass --platform with --min/--latest to preview one.',
    );
    await mongoose.disconnect();
    return;
  }

  // ── Build and validate the proposed state ─────────────────────────────────
  const setMap = {};
  if (newEnabled !== null) {
    setMap['forceUpdate.enabled'] = newEnabled === 'true';
  }
  if (newMin) setMap[`forceUpdate.${platform}.minVersion`] = newMin;
  if (newLatest) setMap[`forceUpdate.${platform}.latestVersion`] = newLatest;
  if (newUrl) setMap[`forceUpdate.${platform}.updateUrl`] = newUrl;

  if (platform) {
    const effMin = newMin || cfg.forceUpdate?.[platform]?.minVersion || '';
    const effLatest =
      newLatest || cfg.forceUpdate?.[platform]?.latestVersion || '';

    // The trap that makes a "successful" save do nothing: versionGate clamps
    // minVersion down to latestVersion at read time, so raising only the floor
    // is silently discarded. Refuse it here, where there is somebody to tell.
    if (effMin && effLatest && compareVersions(effMin, effLatest) > 0) {
      console.error(
        `\n❌ minVersion (${effMin}) would exceed latestVersion (${effLatest}).\n` +
          '   versionGate clamps this at read time, so the write would appear to\n' +
          '   succeed and change nothing. Raise --latest in the same run.',
      );
      await mongoose.disconnect();
      process.exit(1);
    }

    // Preview against the merged result, not the payload.
    const proposed = JSON.parse(JSON.stringify(cfg.forceUpdate || {}));
    proposed[platform] = { ...(proposed[platform] || {}) };
    if (newMin) proposed[platform].minVersion = newMin;
    if (newLatest) proposed[platform].latestVersion = newLatest;
    if (newUrl) proposed[platform].updateUrl = newUrl;
    if (newEnabled !== null) proposed.enabled = newEnabled === 'true';

    console.log('\n───────────────────────────────────────────────────────────');
    console.log(`Proposed — ${platform}`);
    console.log('───────────────────────────────────────────────────────────');
    console.log(`     minVersion   : ${proposed[platform].minVersion || '(unset)'}`);
    console.log(`     latestVersion: ${proposed[platform].latestVersion || '(unset)'}`);
    console.log(`     updateUrl    : ${proposed[platform].updateUrl || '(unset)'}`);
    console.log('     would answer:');
    previewVerdicts(proposed, platform, [
      effLatest,
      effMin,
      oneBelow(effMin),
      ...extraProbes,
    ]);

    if (!proposed[platform].updateUrl) {
      console.log(
        '\n⚠️  updateUrl is unset. On a force verdict "Update Now" is the only\n' +
          '   button on screen, and it falls back to appLinks or a hardcoded\n' +
          '   store URL. Set --url so it points where you intend.',
      );
    }
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    await mongoose.disconnect();
    return;
  }

  await AppConfig.updateOne({ key: 'global' }, { $set: setMap });
  console.log('\n✅ Written:');
  for (const [k, v] of Object.entries(setMap)) console.log(`     ${k} = ${v}`);
  console.log(
    '\n   /config/check-version reads the document directly, so this is live now.\n' +
      '   Verify with:\n' +
      '     curl "$API/config/check-version?platform=android&version=<versionName>"',
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌ Failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
