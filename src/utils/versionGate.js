// src/utils/versionGate.js
//
// Build-level gate on step submission: blocks a known-bad app version from
// writing steps, for every user running it at once.
//
// The per-user switch (utils/stepsTracking.js) answers "this device is a bad
// data source". This answers "this BUILD is a bad data source", which is the
// shape the real incident had — one released version inflating step counts on
// every phone it was installed on. Shipping a fix does not solve that on its
// own: a Play Store rollout is gradual and users update when they feel like it,
// so the bad build keeps submitting for weeks after the fix exists.

/** Stable code clients branch on. Distinct from STEPS_TRACKING_DISABLED
 *  because the remedy is different — the user must UPDATE, and the block must
 *  survive a profile fetch (which would otherwise re-enable them instantly and
 *  flap). Do not change: the app and the native Android service both match it. */
const VERSION_BLOCKED_CODE = 'STEPS_VERSION_BLOCKED';

const DEFAULT_MESSAGE =
  'Step tracking is paused on this version of the app. Please update to the latest version to continue earning.';

/**
 * Compare two dotted version strings.
 *
 * Returns -1 if a < b, 1 if a > b, 0 if equal. Missing components count as 0,
 * so '1.7' and '1.7.0' are equal. A non-numeric component becomes 0 rather
 * than NaN — an unparseable version must not silently compare as "less than
 * everything" and get blocked by a minVersion rule it was never meant to match.
 */
function compareVersions(a, b) {
  const parse = (v) =>
    String(v || '')
      .split('.')
      .map((n) => {
        const parsed = parseInt(n, 10);
        return Number.isFinite(parsed) ? parsed : 0;
      });
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/**
 * Decide whether this client's build may submit steps.
 *
 * @param {object} cfg        the AppConfig document (may lack `stepSync`)
 * @param {object} deviceCtx  from deviceContext.middleware; `appVersion` may be null
 * @returns {{ blocked: boolean, reason: string|null, rule: string|null }}
 */
function checkStepSyncVersion(cfg, deviceCtx) {
  const gate = cfg?.stepSync;
  const allow = { blocked: false, reason: null, rule: null };

  // Master switch off, or config predating this feature — nothing is blocked.
  if (!gate || gate.enabled !== true) return allow;

  const message = gate.message || DEFAULT_MESSAGE;
  const version = deviceCtx?.appVersion || null;

  // ── No version reported ───────────────────────────────────────────────────
  // Every build released before version headers existed lands here, so this is
  // opt-in only. Without the explicit flag an unknown version is allowed —
  // failing open, because the alternative is silently blocking the entire
  // pre-telemetry install base the moment the gate is switched on for one bad
  // build.
  if (!version) {
    return gate.blockUnknownVersion === true
      ? { blocked: true, reason: message, rule: 'unknown_version' }
      : allow;
  }

  // ── Exact-match blocklist ─────────────────────────────────────────────────
  // The common case: one known-bad build with good builds either side of it.
  if (Array.isArray(gate.blockedVersions) && gate.blockedVersions.includes(version)) {
    return { blocked: true, reason: message, rule: 'blocked_version' };
  }

  // ── Minimum-version floor ─────────────────────────────────────────────────
  // For a bug that spans every build up to a fix.
  if (gate.minVersion && compareVersions(version, gate.minVersion) < 0) {
    return { blocked: true, reason: message, rule: 'below_min_version' };
  }

  return allow;
}

/**
 * Decide what update prompt (if any) a client should be shown.
 *
 * Extracted from the /config/check-version controller so the decision can be
 * tested directly. It is worth testing: a wrong verdict here is not a cosmetic
 * bug — `force` has no dismiss in the app, so a bad answer makes the app
 * unusable, and it reaches every user at once because it is driven by config
 * rather than by a release.
 *
 * @param {object} forceUpdateCfg  AppConfig.forceUpdate
 * @param {string} platform        'android' | 'ios'
 * @param {string} clientVersion   the INSTALLED build's version
 */
function resolveUpdateRequirement(forceUpdateCfg, platform, clientVersion) {
  const none = { updateRequired: false, updateType: 'none' };

  if (!forceUpdateCfg || forceUpdateCfg.enabled === false) return none;

  const platformCfg = forceUpdateCfg[String(platform || '').toLowerCase()];
  const latestVersion = platformCfg?.latestVersion || '0.0.1';
  let minVersion = platformCfg?.minVersion || '0.0.1';
  const updateUrl = platformCfg?.updateUrl || '';

  const version = String(clientVersion || '').trim();

  // ── Guard: no usable client version ───────────────────────────────────────
  // Never force an update based on a version we could not read. Answering
  // "force" to an unknown version is how a whole install base gets locked out
  // by a client-side reporting bug rather than by an actual policy decision.
  if (!version || !/^\d+(\.\d+)*$/.test(version)) {
    return none;
  }

  // ── Guard: misconfiguration ───────────────────────────────────────────────
  // minVersion above latestVersion means the hard floor is higher than any
  // build that exists — a typo ('17.3' for '1.73') would hard-block everyone,
  // including someone who installed the newest build a minute ago. Clamping to
  // latestVersion preserves the intent (push people up to current) while making
  // it impossible for a typo to lock out a fully up-to-date user.
  if (compareVersions(minVersion, latestVersion) > 0) {
    console.warn(
      `[VersionCheck] ${platform} minVersion (${minVersion}) exceeds latestVersion ` +
        `(${latestVersion}) — clamping. Check the admin config for a typo.`,
    );
    minVersion = latestVersion;
  }

  let updateType = 'none';
  let updateRequired = false;

  if (compareVersions(version, minVersion) < 0) {
    updateType = 'force';
    updateRequired = true;
  } else if (compareVersions(version, latestVersion) < 0) {
    updateType = 'soft';
    updateRequired = true;
  }

  return {
    updateRequired,
    updateType,
    latestVersion,
    minVersion,
    updateUrl,
  };
}

module.exports = {
  VERSION_BLOCKED_CODE,
  DEFAULT_MESSAGE,
  compareVersions,
  checkStepSyncVersion,
  resolveUpdateRequirement,
};
