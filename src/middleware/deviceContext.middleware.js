// src/middleware/deviceContext.middleware.js
//
// Reads the device/build headers that every authenticated client request
// carries and records them on the user.
//
// Why this exists: before it, a bug report like "this user is still getting
// 5,000-step jumps" could not be answered, because nothing anywhere recorded
// which build the steps came from. A Play Store rollout is gradual and users
// update whenever they feel like it, so "we shipped a fix" says nothing about
// whether any particular device is running it.
//
// Headers (sent by the RN app AND by the native Kotlin sync paths):
//   X-App-Version       "1.72"
//   X-App-Build         "72"
//   X-Platform          "android" | "ios"
//   X-OS-Version        "14"
//   X-Device-Model      "Pixel 7"
//   X-Device-Brand      "Google"
//   X-Install-Id        stable per-install uuid
//   X-Client-Source     "app" | "native_service" | "worker"
//
// Everything is optional — an old build sends none of it, and "no headers at
// all" is itself the answer to "did they update?".

const User = require('../models/User.model');

// How stale the stored snapshot may get before we write again. Every request
// would otherwise be a write; the data only needs to be fresh enough to debug.
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// Upper bound on deviceHistory. Enough to see an update trail, small enough
// that a user who reinstalls repeatedly cannot bloat their document.
const MAX_DEVICE_HISTORY = 20;

const str = (v, max = 120) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/** Parse the X-App-* headers into a normalised object (all fields nullable). */
function readDeviceHeaders(req) {
  const h = req.headers || {};
  const rawBuild = str(h['x-app-build'], 20);
  const buildNumber = rawBuild !== null && /^\d+$/.test(rawBuild)
    ? Number(rawBuild)
    : null;

  const rawPlatform = (str(h['x-platform'], 20) || '').toLowerCase();
  const platform = rawPlatform === 'ios' || rawPlatform === 'android'
    ? rawPlatform
    : null;

  return {
    appVersion:   str(h['x-app-version'], 32),
    buildNumber,
    platform,
    osVersion:    str(h['x-os-version'], 32),
    model:        str(h['x-device-model'], 80),
    manufacturer: str(h['x-device-brand'], 80),
    installId:    str(h['x-install-id'], 100),
    lastSource:   str(h['x-client-source'], 32) || 'app',
  };
}

/**
 * True when the incoming build/install differs from what is stored — i.e. this
 * is a genuine change worth appending to the history, not just another request
 * from the same install.
 */
function isNewInstallSnapshot(stored, incoming) {
  if (!stored) return true;
  return (
    stored.appVersion !== incoming.appVersion ||
    stored.buildNumber !== incoming.buildNumber ||
    stored.installId !== incoming.installId ||
    stored.osVersion !== incoming.osVersion
  );
}

/**
 * Records the device snapshot on req.user. Fire-and-forget: a telemetry write
 * must never fail or delay the request it rode in on.
 *
 * Called from `protect` so it covers every authenticated route, including the
 * /health/sync calls made directly by the Android foreground service and
 * WorkManager workers — which are exactly the callers whose build we need.
 */
function captureDeviceContext(req, user) {
  const incoming = readDeviceHeaders(req);
  req.deviceCtx = incoming;

  // Nothing identifying at all — an old build, or a non-app caller. Recording
  // an all-null snapshot would overwrite a good one with nothing.
  if (!incoming.appVersion && !incoming.installId) return;

  try {
    const stored = user.device || null;
    const changed = isNewInstallSnapshot(stored, incoming);
    const lastSeen = stored?.lastSeenAt ? new Date(stored.lastSeenAt).getTime() : 0;
    const stale = Date.now() - lastSeen > REFRESH_INTERVAL_MS;

    if (!changed && !stale) return;

    const now = new Date();
    const set = {
      'device.appVersion':   incoming.appVersion,
      'device.buildNumber':  incoming.buildNumber,
      'device.osVersion':    incoming.osVersion,
      'device.model':        incoming.model,
      'device.manufacturer': incoming.manufacturer,
      'device.installId':    incoming.installId,
      'device.lastSource':   incoming.lastSource,
      'device.lastSeenAt':   now,
    };
    // `platform` is also set by FCM token registration; don't null it out when
    // a caller omits the header.
    if (incoming.platform) {
      set['device.platform'] = incoming.platform;
    }
    // The first build we ever saw is a baseline — write it once, never again.
    if (!stored?.firstSeenVersion && incoming.appVersion) {
      set['device.firstSeenVersion'] = incoming.appVersion;
    }

    const update = { $set: set };

    if (changed) {
      update.$push = {
        deviceHistory: {
          $each: [{
            appVersion:  incoming.appVersion,
            buildNumber: incoming.buildNumber,
            platform:    incoming.platform,
            osVersion:   incoming.osVersion,
            model:       incoming.model,
            installId:   incoming.installId,
            seenAt:      now,
          }],
          // Negative $slice keeps the LAST n — newest entries survive.
          $slice: -MAX_DEVICE_HISTORY,
        },
      };
    }

    User.updateOne({ _id: user._id }, update).catch(() => {});

    // Keep the in-memory doc consistent for the rest of this request, so a
    // controller reading req.user.device sees exactly what was just written.
    // Built from `set` rather than from `incoming` so the fields deliberately
    // left out of the write — notably a null platform — are not nulled here
    // either.
    const merged = stored?.toObject?.() ?? { ...(stored || {}) };
    for (const [path, value] of Object.entries(set)) {
      merged[path.replace('device.', '')] = value;
    }
    user.device = merged;
  } catch {
    // Telemetry is best-effort by definition.
  }
}

module.exports = { captureDeviceContext, readDeviceHeaders };
