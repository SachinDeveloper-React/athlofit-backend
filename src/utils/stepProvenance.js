// src/utils/stepProvenance.js
//
// Turns the `stepSource` block a client attaches to /health/sync into a ledger
// row, and writes it.
//
// ── Why the client has to tell us ───────────────────────────────────────────
//
// The server sees one number per sync and cannot reconstruct where it came
// from. The client already knows in full detail — `readTodayStepsDetailed`
// (JS) and `StepOriginDedup` (Kotlin) both compute the per-origin breakdown,
// the dedup verdict for each origin, and the timestamps of every underlying
// record — and every one of those paths threw the detail away before POSTing.
// The payload block carries it across; this file is where it lands.
//
// ── Trust ───────────────────────────────────────────────────────────────────
//
// It is client-supplied, so it is DIAGNOSTIC ONLY and never feeds a decision.
// Nothing here is read by validation, by coin awards, or by the stored step
// total; a device that lies about its provenance changes what the ledger says
// about itself and nothing else. Everything is clamped and length-limited on
// the way in regardless, because it is written to a document that an admin
// screen renders.
//
// The one fact here the client cannot forge is `daysLate`, which is computed
// from the server clock against the date being written.

const StepProvenance = require('../models/StepProvenance.model');
const { MAX_ENTRIES } = require('../models/StepProvenance.model');
const { daysBetween, toClientDate } = require('./date');

/** Ceiling on a single day, matching stepValidation and the two clients. */
const MAX_SANE_DAILY_STEPS = 100_000;

/** Origins kept per entry. A phone with more than this is not a real phone. */
const MAX_ORIGINS = 12;

const HOURS_PER_DAY = 24;

const str = (v, max = 120) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

const num = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Readers we accept a claim from.
 *
 * An allowlist rather than a free string, because the reader is the first
 * thing every step investigation branches on: 'health_connect' means the
 * dedup and the origin list below are meaningful, 'native_sensor' means there
 * are no origins and no record timestamps to reason about. A typo'd or novel
 * value would silently read as a third kind of source that does not exist.
 */
const READERS = new Set(['health_connect', 'native_sensor', 'server', 'unknown']);

/**
 * Normalises an incoming `stepSource` block. Returns null when there is nothing
 * usable, so callers can treat "no provenance" as its own state rather than as
 * an empty breakdown — a build too old to send the block is a different fact
 * from a device that read no records.
 */
function normalizeStepSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const reader = str(raw.reader, 32);
  const origins = Array.isArray(raw.origins)
    ? raw.origins
        .map((o) => ({
          packageName: str(o?.packageName ?? o?.pkg, 120),
          steps: num(o?.steps, 0, MAX_SANE_DAILY_STEPS) ?? 0,
          contributed: num(o?.contributed, 0, MAX_SANE_DAILY_STEPS) ?? 0,
          disjointFraction: Math.min(
            1,
            Math.max(0, Number(o?.disjointFraction) || 0),
          ),
        }))
        .filter((o) => o.packageName)
        // Largest first: the origin most of the steps came from is the one a
        // reader wants at the top, and it is also the one that survives the cap.
        .sort((a, b) => b.steps - a.steps)
        .slice(0, MAX_ORIGINS)
    : [];

  // A fixed 24-slot histogram. Anything longer is truncated rather than
  // rejected, so a client bug in one field cannot cost us the whole block.
  const hourly = Array.isArray(raw.hourly)
    ? Array.from({ length: HOURS_PER_DAY }, (_, i) =>
        num(raw.hourly[i], 0, MAX_SANE_DAILY_STEPS) ?? 0,
      )
    : [];

  const normalized = {
    reader: READERS.has(reader) ? reader : 'unknown',
    method: str(raw.method, 40),
    primaryOrigin: str(raw.primaryOrigin, 120),
    origins,
    hourly: hourly.some((h) => h > 0) ? hourly : [],
    recordedFrom: date(raw.recordedFrom),
    recordedTo: date(raw.recordedTo),
    recordCount: num(raw.recordCount, 0, 100_000) ?? 0,
    // Capped at a year. An uncapped client number would render as an absurd
    // "offline for 4,000 days" in the admin view.
    offlineMinutes: num(raw.offlineMinutes, 0, 365 * 24 * 60),
  };

  // Nothing was actually said. Distinguishing this from a populated block is
  // the reason for returning null rather than an empty shell.
  const saidSomething =
    normalized.reader !== 'unknown' ||
    normalized.origins.length > 0 ||
    normalized.hourly.length > 0 ||
    normalized.recordCount > 0 ||
    normalized.recordedFrom !== null;

  return saidSomething ? normalized : null;
}

/**
 * Builds the ledger row for one accepted increase.
 *
 * Pure — no clock beyond the `at` passed in, no I/O — so the lateness and
 * attribution logic can be tested directly. `source` may be null: an increase
 * from a build that sends no provenance is still worth a row, because "steps
 * arrived and nothing said where from" is itself the finding, and a gap in the
 * ledger would read as no steps having arrived at all.
 */
function buildProvenanceEntry({
  from,
  to,
  source,
  syncDate,
  timezone,
  deviceCtx,
  at = new Date(),
}) {
  const walkedFrom = Math.max(0, Math.round(Number(from) || 0));
  const walkedTo = Math.max(0, Math.round(Number(to) || 0));

  // Lateness in the USER's days, not UTC ones. `toClientDate` is how every
  // other date decision on the sync path is resolved; using the server day here
  // would report a spurious day of lateness for anyone whose local date differs
  // from the server's at the moment they sync — which for a UTC server and an
  // IST user is every evening.
  const deliveredOn = toClientDate(at, timezone);
  const daysLate = Math.max(0, daysBetween(syncDate, deliveredOn) ?? 0);

  return {
    at,
    from: walkedFrom,
    to: walkedTo,
    delta: walkedTo - walkedFrom,
    reader: source?.reader ?? 'unknown',
    method: source?.method ?? null,
    primaryOrigin: source?.primaryOrigin ?? null,
    origins: source?.origins ?? [],
    recordedFrom: source?.recordedFrom ?? null,
    recordedTo: source?.recordedTo ?? null,
    recordCount: source?.recordCount ?? 0,
    daysLate,
    offlineMinutes: source?.offlineMinutes ?? null,
    appVersion: deviceCtx?.appVersion ?? null,
    buildNumber: deviceCtx?.buildNumber ?? null,
    platform: deviceCtx?.platform ?? null,
    clientSource: deviceCtx?.lastSource ?? null,
  };
}

/**
 * Element-wise max of two hourly histograms.
 *
 * Max rather than sum, because each read reports the day CUMULATIVELY from
 * local midnight — the 09:00 slot in the 10am sync and in the 6pm sync describe
 * the same steps, so adding successive syncs would multiply the day by however
 * often the device happened to sync. Max also survives the case that motivates
 * the whole file: a late backlog arriving after a partial live sync, where the
 * backlog knows about hours the live sync never saw.
 */
function mergeHourly(existing, incoming) {
  if (!incoming?.length) return existing ?? [];
  if (!existing?.length) return incoming.slice(0, HOURS_PER_DAY);
  return Array.from({ length: HOURS_PER_DAY }, (_, i) =>
    Math.max(existing[i] || 0, incoming[i] || 0),
  );
}

/**
 * Rolls the day's per-origin totals forward.
 *
 * Same reasoning as mergeHourly: each read is cumulative for the day, so an
 * origin's figure is a high-water mark, not something to add to. Origins seen
 * in an earlier sync and absent from this one are KEPT — Health Connect can
 * stop returning an app's records (it was uninstalled, or the user revoked its
 * permission) and dropping it would erase the attribution for steps that are
 * still counted in the day's total.
 */
function mergeOrigins(existing, incoming) {
  const byName = new Map();
  for (const o of existing ?? []) {
    if (o?.packageName) byName.set(o.packageName, { ...(o.toObject?.() ?? o) });
  }
  for (const o of incoming ?? []) {
    const prev = byName.get(o.packageName);
    byName.set(o.packageName, {
      packageName: o.packageName,
      steps: Math.max(prev?.steps ?? 0, o.steps ?? 0),
      contributed: Math.max(prev?.contributed ?? 0, o.contributed ?? 0),
      // The latest verdict, not the highest: whether an origin is a mirror is a
      // judgement about the current data, and a stale high value would keep
      // claiming independence for a source now judged a duplicate.
      disjointFraction: o.disjointFraction ?? prev?.disjointFraction ?? 0,
    });
  }
  return [...byName.values()].sort((a, b) => b.steps - a.steps);
}

/**
 * Records one accepted step increase against the day it belongs to.
 *
 * Fire-and-forget and never throws, for the same reason as recordSyncLog: this
 * rides on the hot sync path and must not be able to slow down or fail a user's
 * step submission.
 *
 * Only called when walked steps actually moved UP. A re-send of the same count,
 * a hydration-only sync, or a rejected lower figure add nothing to explain, and
 * logging them would bury the increases that do need explaining.
 */
function recordStepProvenance(req, {
  date: syncDate,
  from,
  to,
  bonusSteps = 0,
  source,
  timezone = null,
}) {
  try {
    if (!req?.user?._id || !syncDate) return;
    if (!(to > from)) return;

    const at = new Date();
    const entry = buildProvenanceEntry({
      from,
      to,
      source,
      syncDate,
      timezone,
      deviceCtx: req.deviceCtx,
      at,
    });

    const update = {
      $set: {
        walkedSteps: entry.to,
        bonusSteps,
        totalSteps: entry.to + bonusSteps,
        lastSyncAt: at,
      },
      // setOnInsert, so the first sync of the day is preserved even though
      // every later one updates lastSyncAt.
      $setOnInsert: { user: req.user._id, date: syncDate, firstSyncAt: at },
      $inc: { increaseCount: 1 },
      $push: {
        entries: {
          $each: [entry],
          // Negative $slice keeps the LAST n — the newest entries survive, which
          // is the right end to keep when a day is still being written to.
          $slice: -MAX_ENTRIES,
        },
      },
      // $addToSet, so a day fed by two readers records both rather than
      // whichever synced last.
      $addToSet: { readers: entry.reader },
    };

    if (timezone) update.$set.timezone = timezone;

    // The rolled-up day view needs the PREVIOUS state to merge against, which no
    // single atomic operator can express. Read then write: a lost update here
    // costs one sync's worth of histogram detail in a diagnostic document, and
    // the ledger entry above — the authoritative record — is written
    // atomically either way.
    StepProvenance.findOne({ user: req.user._id, date: syncDate })
      .select('hourly origins entries increaseCount')
      .lean()
      .then((existing) => {
        const hourly = mergeHourly(existing?.hourly, source?.hourly);
        if (hourly.length) update.$set.hourly = hourly;

        const origins = mergeOrigins(existing?.origins, source?.origins);
        if (origins.length) update.$set.origins = origins;

        // Count what the cap is about to drop, so the ledger never looks
        // complete when it is not.
        if ((existing?.entries?.length ?? 0) >= MAX_ENTRIES) {
          update.$inc.droppedEntries = 1;
        }

        return StepProvenance.updateOne(
          { user: req.user._id, date: syncDate },
          update,
          { upsert: true },
        );
      })
      .catch(() => {});
  } catch {
    // Diagnostics must never break the thing they are diagnosing.
  }
}

/**
 * One line of plain English for a ledger row.
 *
 * Lives here rather than in the admin controller because it is the shape of the
 * answer this whole model exists to produce, and it is worth being able to test
 * it directly against a row.
 */
function describeEntry(entry) {
  if (!entry) return '';
  const parts = [];
  parts.push(`+${entry.delta.toLocaleString('en-US')} steps (${entry.from.toLocaleString('en-US')} → ${entry.to.toLocaleString('en-US')})`);

  if (entry.reader === 'health_connect') {
    const primary = entry.primaryOrigin || 'an unnamed app';
    const added = (entry.origins || []).filter(
      (o) => o.packageName !== entry.primaryOrigin && o.contributed > 0,
    );
    const mirrored = (entry.origins || []).filter(
      (o) => o.packageName !== entry.primaryOrigin && o.contributed === 0,
    );
    parts.push(`from Health Connect, mostly ${primary}`);
    if (added.length) {
      parts.push(
        `plus ${added.map((o) => `${o.packageName} +${o.contributed}`).join(', ')}`,
      );
    }
    if (mirrored.length) {
      parts.push(
        `not counted (duplicate of ${primary}): ${mirrored.map((o) => `${o.packageName} ${o.steps}`).join(', ')}`,
      );
    }
  } else if (entry.reader === 'native_sensor') {
    parts.push('from this phone\'s hardware step sensor (no per-app breakdown)');
  } else if (entry.reader === 'server') {
    parts.push('carried over from another device that had already synced');
  } else {
    parts.push('from a build that does not report its step source');
  }

  if (entry.recordedFrom && entry.recordedTo) {
    const fmt = (d) => new Date(d).toISOString().slice(11, 16);
    parts.push(
      `recorded ${fmt(entry.recordedFrom)}–${fmt(entry.recordedTo)} UTC across ${entry.recordCount} record${entry.recordCount === 1 ? '' : 's'}`,
    );
  }

  if (entry.daysLate > 0) {
    parts.push(
      `delivered ${entry.daysLate} day${entry.daysLate === 1 ? '' : 's'} late — these are NOT steps walked on the day they arrived`,
    );
  }
  if (entry.offlineMinutes >= 60) {
    parts.push(`device had not synced for ${Math.round(entry.offlineMinutes / 60)}h`);
  }
  if (entry.clientSource) parts.push(`via ${entry.clientSource}`);

  return parts.join('; ');
}

module.exports = {
  normalizeStepSource,
  buildProvenanceEntry,
  mergeHourly,
  mergeOrigins,
  recordStepProvenance,
  describeEntry,
  MAX_ORIGINS,
  MAX_ENTRIES,
};
