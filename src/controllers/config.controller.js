// src/controllers/config.controller.js
// ─── All config is now stored in MongoDB — zero hardcoded values ──────────────

const AppConfig = require("../models/AppConfig.model");
const Faq = require("../models/Faq.model");
const LegalContent = require("../models/LegalContent.model");
const SupportTicket = require("../models/SupportTicket.model");
const { success, error } = require("../utils/response");
const { resolveUpdateRequirement, compareVersions } = require("../utils/versionGate");
const { describePassiveCoinCap } = require("../utils/passiveCoins");
const { describeDailyRewardCap } = require("../utils/dailyCoinCap");
const Challenge = require("../models/Challenge.model");
const {
  DEFAULT_RATE_PER_100_STEPS,
  MAX_COIN_RATE_PER_100_STEPS,
  DEFAULT_DAILY_EARN_LIMIT,
  DEFAULT_MAX_DAILY_REWARDS,
} = require("../constants/coinDefaults");

/**
 * Adds up what one day of rewards can pay, from LIVE config and LIVE challenges.
 *
 * Kept next to the config endpoints rather than in the util so the util stays
 * pure and testable; this half is the database read.
 *
 * Only ACTIVE challenges count — a deactivated one pays nobody, so including it
 * would inflate the ceiling an admin is being asked to size against.
 */
async function summariseDailyRewardCap(cfg) {
  // Never fatal. This is advice for whoever is editing the config, and a
  // problem reading the challenge collection must not stop the config itself
  // being saved — the same rule the rest of the diagnostics on this codebase
  // follow. Returning null lets the caller omit the field rather than report a
  // ceiling computed from challenges it could not actually see.
  let active;
  try {
    active = await Challenge.find({ isActive: true })
      .select("type coinReward")
      .lean();
  } catch (err) {
    console.warn(`[Config] could not read challenges for cap summary: ${err.message}`);
    return null;
  }

  const sumOf = (type) =>
    active
      .filter((c) => c.type === type)
      .reduce((total, c) => total + (c.coinReward || 0), 0);

  return describeDailyRewardCap({
    maxDailyRewards: cfg.coin?.maxDailyRewards ?? DEFAULT_MAX_DAILY_REWARDS,
    dailyEarnLimit: cfg.coin?.dailyEarnLimit ?? DEFAULT_DAILY_EARN_LIMIT,
    stepGoalCoins:
      cfg.coin_config?.rewards?.daily_step_goal_reached?.coin_value ??
      cfg.rewards?.stepGoalCoins ??
      0,
    hydrationGoalCoins: cfg.rewards?.hydrationGoalCoins ?? 0,
    dailyChallengeCoins: sumOf("daily"),
    weeklyChallengeCoins: sumOf("weekly"),
  });
}

/**
 * GET /config/coin-economy — admin only.
 *
 * What the admin panel needs BEFORE editing a cap, not after: the ceilings as
 * configured, what a day can actually pay at those settings, and whether the cap
 * binds. Without it, setting `maxDailyRewards` is guesswork against numbers
 * spread over the config document and the challenge collection.
 */
const getCoinEconomy = async (req, res, next) => {
  try {
    const cfg = (await AppConfig.findOne({ key: "global" }).lean()) || {};
    const [dailyRewardCap, passiveCoinCap] = [
      await summariseDailyRewardCap(cfg),
      describePassiveCoinCap(
        cfg.coin_config?.steps?.rate_per_100_steps ?? DEFAULT_RATE_PER_100_STEPS,
        cfg.coin?.dailyEarnLimit ?? DEFAULT_DAILY_EARN_LIMIT,
      ),
    ];
    return success(res, "Coin economy", { dailyRewardCap, passiveCoinCap });
  } catch (err) {
    return next(err);
  }
};

const { LEGAL_TYPES } = LegalContent;

// Human-readable default titles for each legal type
const LEGAL_TITLES = {
  terms: "Terms & Conditions",
  privacy: "Privacy Policy",
  "coin-earning": "Coin Earning & Rewards Policy",
  "coin-redemption": "Coin Redemption Policy",
  "community-guidelines": "Community Guidelines",
  "data-deletion": "Data Deletion Policy",
  "medical-disclaimer": "Medical / Fitness Disclaimer",
  refund: "Refund & Cancellation Policy",
};

// Convert content to clean HTML for the mobile app.
// If already HTML, just sanitize. If markdown, convert via `marked`.
function toHtml(raw) {
  if (!raw || !raw.trim()) return '';
  let html = raw;
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(html);
  if (!looksLikeHtml) {
    const { marked } = require('marked');
    html = marked.parse(html);
  }
  // Strip artifacts + empty paragraphs + nbsp
  html = html
    .replace(/&nbsp;/g, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\s*class="[^"]*"/gi, '')
    .replace(/\s*style="[^"]*"/gi, '')
    .replace(/<p>\s*<br\s*\/?>\s*<\/p>/gi, '')
    .replace(/<p>\s*<\/p>/gi, '');
  return html.trim();
}

// ─── Internal: get or seed the single global config doc ──────────────────────
async function getOrCreateConfig() {
  let cfg = await AppConfig.findOne({ key: "global" });
  if (!cfg) {
    cfg = await AppConfig.create({ key: "global" });
  }
  return cfg;
}

// ─── GET /config/app ──────────────────────────────────────────────────────────
// Returns the full runtime config consumed by the mobile app.
// Admins can update values via PATCH /config/app (admin-only).
const getAppConfig = async (req, res, next) => {
  try {
    const cfg = await getOrCreateConfig();

    // Shape matches what the frontend AppConfigStore expects
    const config = {
      coin: {
        conversionRate: cfg.coin.conversionRate,
        dailyEarnLimit: cfg.coin.dailyEarnLimit,
        maxDailyRewards: cfg.coin.maxDailyRewards,
        coinsPerStepKm: cfg.coin.coinsPerStepKm,
        purchaseEnabled: cfg.coin.purchaseEnabled,
        referrerBonus: cfg.coin.referrerBonus,
        refereeBonus: cfg.coin.refereeBonus,
      },
      steps: {
        defaultDailyGoal: cfg.steps.defaultDailyGoal,
        maxDailyGoal: cfg.steps.maxDailyGoal,
      },
      rewards: {
        stepGoalCoins: cfg.rewards.stepGoalCoins,
        hydrationGoalCoins: cfg.rewards.hydrationGoalCoins,
        hydrationGoalMl: cfg.rewards.hydrationGoalMl,
      },
      features: {
        shopEnabled: cfg.features.shopEnabled,
        ordersEnabled: cfg.features.ordersEnabled,
        healthAnalyticsEnabled: cfg.features.healthAnalyticsEnabled,
        referralEnabled: cfg.features.referralEnabled,
        leaderboardEnabled: cfg.features.leaderboardEnabled,
      },
      maintenance: {
        enabled: cfg.maintenance.enabled,
        message: cfg.maintenance.message,
      },
      // Whether streak badges currently carry coin rewards. Exposed so the app
      // can present a badge as an achievement rather than advertising a coin
      // amount it will not receive. Per-badge truth is on the badge itself
      // (`payoutEligible`); this is the global state for copy and layout.
      streak: {
        badgeCoinsEnabled: cfg.streak?.badgeCoinsEnabled ?? false,
      },
      // Build-level step-sync gate. Exposed so the admin panel can read the
      // current state, and so the app can show the update prompt before its
      // first sync is rejected rather than after. Nothing here is sensitive —
      // a blocked client is told exactly this in the 403 anyway.
      stepSync: {
        enabled: cfg.stepSync?.enabled ?? false,
        blockedVersions: cfg.stepSync?.blockedVersions ?? [],
        minVersion: cfg.stepSync?.minVersion ?? '',
        blockUnknownVersion: cfg.stepSync?.blockUnknownVersion ?? false,
        message: cfg.stepSync?.message ?? '',
      },
      // Update gate. Read-only here; written through PATCH /config/app.
      //
      // This was the one config block with no way to read back what was stored,
      // and it is the block where a wrong value is least visible: a verdict of
      // "no update" looks identical whether it was the intended answer or the
      // result of versions saved in the wrong numbering scheme. Exactly that
      // happened — android held '0.0.77' (the package.json version) while every
      // client reports versionName '1.77', so every client compared as newer
      // and no prompt ever fired. Nobody could see it because nothing returned
      // it. Exposing it is what makes that class of mistake noticeable.
      forceUpdate: {
        enabled: cfg.forceUpdate?.enabled ?? true,
        android: {
          minVersion: cfg.forceUpdate?.android?.minVersion ?? '',
          latestVersion: cfg.forceUpdate?.android?.latestVersion ?? '',
          updateUrl: cfg.forceUpdate?.android?.updateUrl ?? '',
        },
        ios: {
          minVersion: cfg.forceUpdate?.ios?.minVersion ?? '',
          latestVersion: cfg.forceUpdate?.ios?.latestVersion ?? '',
          updateUrl: cfg.forceUpdate?.ios?.updateUrl ?? '',
        },
        title: cfg.forceUpdate?.title ?? '',
        message: cfg.forceUpdate?.message ?? '',
      },
      support: {
        email: cfg.support.email,
        website: cfg.support.website,
        phone: cfg.support?.phone ?? '',
        address: cfg.support?.address ?? '',
        whatsapp: cfg.support?.whatsapp ?? '919310777797',
        whatsappMessage: cfg.support?.whatsappMessage ?? 'Hello, I need support with Athlofit app',
      },
      appLinks: {
        playStore: cfg.appLinks?.playStore ?? '',
        appStore: cfg.appLinks?.appStore ?? '',
        universal: cfg.appLinks?.universal ?? '',
        showBadges: cfg.appLinks?.showBadges ?? true,
      },
      social: {
        instagram: cfg.social?.instagram ?? '',
        twitter: cfg.social?.twitter ?? '',
        facebook: cfg.social?.facebook ?? '',
        youtube: cfg.social?.youtube ?? '',
        linkedin: cfg.social?.linkedin ?? '',
      },
      website: {
        siteName: cfg.website?.siteName ?? 'Athlofit',
        defaultMetaTitle: cfg.website?.defaultMetaTitle ?? 'Athlofit — Walk. Earn. Shop.',
        defaultMetaDescription:
          cfg.website?.defaultMetaDescription ??
          'Track your fitness, earn coins by walking, and shop premium health products.',
        ogImage: cfg.website?.ogImage ?? '',
        logoUrl: cfg.website?.logoUrl ?? '',
        razorpayEnabled: cfg.website?.razorpayEnabled ?? false,
      },
      coin_config: {
        steps: {
          // Was 0.00095 here while every other reader defaulted to 0.5, so a
          // missing field made the app display a rate 526x below what the
          // server was paying. See constants/coinDefaults.js.
          rate_per_100_steps:
            cfg.coin_config?.steps?.rate_per_100_steps ??
            DEFAULT_RATE_PER_100_STEPS,
        },
        rewards: {
          daily_step_goal_reached: {
            enabled:
              cfg.coin_config?.rewards?.daily_step_goal_reached?.enabled ??
              true,
            coin_value:
              cfg.coin_config?.rewards?.daily_step_goal_reached?.coin_value ??
              50,
          },
        },
      },
    };

    return success(res, "App config fetched", { config });
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /config/app  (admin only) ─────────────────────────────────────────
// Deep-merges any subset of the config. E.g. { "coin.conversionRate": 12 }
// or { coin: { conversionRate: 12 } }
const updateAppConfig = async (req, res, next) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== "object") {
      return error(res, "Request body must be a config object", 400);
    }

    // Build a flat $set map so nested keys are merged, not replaced
    const setMap = {};
    const flatten = (obj, prefix = "") => {
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          flatten(v, path);
        } else {
          setMap[path] = v;
        }
      }
    };
    flatten(updates);

    // ─── Validate coin_config fields before persisting ──────────────────────────
    if (setMap["coin_config.steps.rate_per_100_steps"] !== undefined) {
      const rate = Number(setMap["coin_config.steps.rate_per_100_steps"]);
      // The old bound was 1000, which at MAX_DAILY_STEPS is 500,000 coins in a
      // single day — far past anything a typo should be able to reach, let alone
      // an intended setting. MAX_COIN_RATE_PER_100_STEPS still leaves several
      // orders of magnitude of headroom over the rates actually in use.
      if (isNaN(rate) || rate <= 0 || rate > MAX_COIN_RATE_PER_100_STEPS) {
        return error(
          res,
          `rate_per_100_steps must be a positive number (max ${MAX_COIN_RATE_PER_100_STEPS})`,
          400,
        );
      }
      setMap["coin_config.steps.rate_per_100_steps"] = rate;
    }
    if (setMap["coin.dailyEarnLimit"] !== undefined) {
      const limit = Number(setMap["coin.dailyEarnLimit"]);
      if (isNaN(limit) || limit < 0) {
        return error(res, "dailyEarnLimit must be a non-negative number", 400);
      }
      setMap["coin.dailyEarnLimit"] = limit;
    }
    // maxDailyRewards and unverifiedDailyCap had no validation at all, unlike
    // dailyEarnLimit right above them — so a typo could store a negative number
    // or a string, and every award path would then quietly pay nothing. They are
    // the ceilings the whole coin economy is measured against; they deserve at
    // least as much checking as the limit they sit next to.
    for (const key of ["coin.maxDailyRewards", "coin.unverifiedDailyCap"]) {
      if (setMap[key] === undefined) continue;
      const value = Number(setMap[key]);
      if (isNaN(value) || value < 0) {
        return error(
          res,
          `${key.split(".")[1]} must be a non-negative number`,
          400,
        );
      }
      setMap[key] = value;
    }
    if (
      setMap["coin_config.rewards.daily_step_goal_reached.coin_value"] !==
      undefined
    ) {
      const val = Number(setMap["coin_config.rewards.daily_step_goal_reached.coin_value"]);
      if (isNaN(val) || val < 0) {
        return error(res, "coin_value must be a non-negative number", 400);
      }
      setMap["coin_config.rewards.daily_step_goal_reached.coin_value"] = val;
    }

    // ─── Validate the update gate before persisting ─────────────────────────
    //
    // Held to a higher standard than the coin fields above, because the blast
    // radius is different: `force` has no dismiss button in the app, so a wrong
    // floor here makes Athlofit unusable for everyone running that platform,
    // from one write, with no release involved and no way to walk it back on
    // the devices already showing the modal.
    if (Object.keys(setMap).some((k) => k.startsWith("forceUpdate."))) {
      // Partial writes are the normal case — the admin panel sends one field at
      // a time — so what has to be validated is the MERGED result, not the
      // payload. Raising minVersion alone is exactly the shape that needs it:
      // on its own the value looks fine, and only contradicts the latestVersion
      // already stored in the database.
      const stored = await getOrCreateConfig();

      for (const platform of ["android", "ios"]) {
        const effective = (field) => {
          const key = `forceUpdate.${platform}.${field}`;
          return setMap[key] !== undefined
            ? String(setMap[key] ?? "").trim()
            : String(stored.forceUpdate?.[platform]?.[field] ?? "").trim();
        };

        const minVersion = effective("minVersion");
        const latestVersion = effective("latestVersion");

        for (const [field, value] of [
          ["minVersion", minVersion],
          ["latestVersion", latestVersion],
        ]) {
          // Only the incoming fields are shape-checked. A pre-existing bad
          // value must not make an unrelated edit to this block impossible to
          // save — that would leave the config wedged with no way out.
          if (setMap[`forceUpdate.${platform}.${field}`] === undefined) continue;
          if (!/^\d+(\.\d+)*$/.test(value)) {
            return error(
              res,
              `forceUpdate.${platform}.${field} must be a dotted numeric version (e.g. "1.78"), got "${value}"`,
              400,
            );
          }
        }

        // Rejected outright rather than left to the read-time clamp in
        // versionGate. That clamp is a safety net for values already stored; it
        // resolves the contradiction silently, so an admin who sets only
        // minVersion sees a successful save and no prompt on any device, with
        // nothing anywhere saying why.
        if (
          minVersion &&
          latestVersion &&
          compareVersions(minVersion, latestVersion) > 0
        ) {
          return error(
            res,
            `forceUpdate.${platform}.minVersion (${minVersion}) cannot exceed latestVersion (${latestVersion}) — ` +
              `raise latestVersion in the same request, or users already on the newest build would be hard-blocked`,
            400,
          );
        }
      }
    }

    const cfg = await AppConfig.findOneAndUpdate(
      { key: "global" },
      { $set: setMap },
      { new: true, upsert: true },
    );

    // Invalidate the in-memory config cache so changes take effect immediately.
    try {
      require('../utils/configCache').invalidateConfigCache();
    } catch (_) { /* cache module optional */ }
    try {
      require('../utils/appConfigCache').invalidateAppConfigCache();
    } catch (_) { /* cache module optional */ }

    // ── Report whether the passive daily cap can still bind ──────────────────
    // The per-step rate and dailyEarnLimit are stored independently and were
    // never compared, so the cap silently stopped being reachable: 0.095/100
    // steps pays at most 47.5 coins/day, against a limit of 200. Whoever edits
    // either value is the one person positioned to notice, so they are told
    // here — in the response and in the log — rather than finding out from a
    // payout months later.
    const touchedCoinEconomy =
      setMap["coin_config.steps.rate_per_100_steps"] !== undefined ||
      setMap["coin.dailyEarnLimit"] !== undefined ||
      setMap["coin.maxDailyRewards"] !== undefined ||
      setMap["coin.unverifiedDailyCap"] !== undefined ||
      setMap["rewards.stepGoalCoins"] !== undefined ||
      setMap["rewards.hydrationGoalCoins"] !== undefined;

    let passiveCoinCap;
    let dailyRewardCap;
    if (touchedCoinEconomy) {
      passiveCoinCap = describePassiveCoinCap(
        cfg.coin_config?.steps?.rate_per_100_steps ?? DEFAULT_RATE_PER_100_STEPS,
        cfg.coin?.dailyEarnLimit ?? DEFAULT_DAILY_EARN_LIMIT,
      );
      const log = passiveCoinCap.capBinds ? console.log : console.warn;
      log(`[Config] ${passiveCoinCap.summary}`);

      // The same service for the OVERALL ceiling. Read from live challenge
      // content rather than from constants, because what a day can pay depends
      // on the challenges this deployment actually has active — a number derived
      // from the seed file would be wrong the moment an admin adds one.
      dailyRewardCap = await summariseDailyRewardCap(cfg);
      if (dailyRewardCap) {
        const capLog = dailyRewardCap.capBinds ? console.log : console.warn;
        capLog(`[Config] ${dailyRewardCap.summary}`);
      }
    }

    // `cfg` is a Mongoose document in production but a plain object under test
    // and wherever findOneAndUpdate is given `lean`, so the conversion has to be
    // optional — assuming the document shape here turned a config edit into a
    // 500.
    const body = typeof cfg?.toObject === "function" ? cfg.toObject() : cfg;

    return success(res, "App config updated", {
      ...body,
      passiveCoinCap,
      dailyRewardCap,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /config/terms ────────────────────────────────────────────────────────
const getTerms = async (req, res, next) => {
  try {
    let doc = await LegalContent.findOne({ type: "terms" });

    // Seed default if not in DB yet
    if (!doc) {
      doc = await LegalContent.create({
        type: "terms",
        title: "Terms & Conditions",
        version: "1.0",
        content: `# Terms & Conditions

Welcome to Athlofit. By using our application, you agree to these terms.

## 1. User Account
You are responsible for maintaining the confidentiality of your account credentials.

## 2. Health Disclaimer
Athlofit provides health tracking and wellness information for informational purposes only. It is not a substitute for professional medical advice.

## 3. Data Usage
We collect health data to provide analytics and personalized tracking. Your data is stored securely.

## 4. Updates
We may update these terms from time to time. Your continued use of the app constitutes acceptance of the new terms.`,
      });
    }

    return success(res, "Terms fetched", {
      content: doc.content,
      htmlContent: toHtml(doc.content),
      version: doc.version,
      updatedAt: doc.updatedAt,
    });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /config/terms  (admin only) ─────────────────────────────────────────
const updateTerms = async (req, res, next) => {
  try {
    const { content, version } = req.body;
    if (!content) return error(res, "content is required", 400);

    const doc = await LegalContent.findOneAndUpdate(
      { type: "terms" },
      { $set: { content, ...(version && { version }) } },
      { new: true, upsert: true },
    );

    return success(res, "Terms updated", doc);
  } catch (err) {
    next(err);
  }
};

// ─── GET /config/privacy ──────────────────────────────────────────────────────
const getPrivacy = async (req, res, next) => {
  try {
    let doc = await LegalContent.findOne({ type: "privacy" });

    if (!doc) {
      doc = await LegalContent.create({
        type: "privacy",
        title: "Privacy Policy",
        version: "1.0",
        content: `# Privacy Policy

Your privacy is important to us.

## 1. Data Collection
We collect steps, hydration, and other health metrics you provide to visualize your progress.

## 2. Data Security
We use industry-standard encryption to protect your personal and health information.

## 3. Third-Party Sharing
We do not sell your personal data to third parties.

## 4. Your Rights
You can request to delete your account and associated data at any time through the app settings.`,
      });
    }

    return success(res, "Privacy policy fetched", {
      content: doc.content,
      htmlContent: toHtml(doc.content),
      version: doc.version,
      updatedAt: doc.updatedAt,
    });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /config/privacy  (admin only) ───────────────────────────────────────
const updatePrivacy = async (req, res, next) => {
  try {
    const { content, version } = req.body;
    if (!content) return error(res, "content is required", 400);

    const doc = await LegalContent.findOneAndUpdate(
      { type: "privacy" },
      { $set: { content, ...(version && { version }) } },
      { new: true, upsert: true },
    );

    return success(res, "Privacy policy updated", doc);
  } catch (err) {
    next(err);
  }
};

// ─── GET /config/legal ────────────────────────────────────────────────────────
// Returns a list of all published legal documents (type, title, version, updatedAt).
// Used by the website footer / legal index page.
const getLegalList = async (req, res, next) => {
  try {
    const docs = await LegalContent.find({ isPublished: true })
      .select("type title version updatedAt")
      .sort({ title: 1 });

    return success(res, "Legal documents fetched", docs);
  } catch (err) {
    next(err);
  }
};

// ─── GET /config/legal/:type ────────────────────────────────────────────────
// Returns a single legal document by type. Seeds a placeholder if missing.
const getLegalByType = async (req, res, next) => {
  try {
    const { type } = req.params;

    if (!LEGAL_TYPES.includes(type)) {
      return error(res, `Unknown legal document type: ${type}`, 404);
    }

    let doc = await LegalContent.findOne({ type });

    if (!doc) {
      doc = await LegalContent.create({
        type,
        title: LEGAL_TITLES[type] || type,
        version: "1.0",
        content: `# ${LEGAL_TITLES[type] || type}\n\nThis document has not been published yet. Please check back soon.`,
        isPublished: false,
      });
    }

    // Generate HTML for the mobile app.
    let htmlContent = toHtml(doc.content);

    return success(res, "Legal document fetched", {
      type: doc.type,
      title: doc.title,
      content: doc.content,       // raw (markdown or HTML) — used by admin editor
      htmlContent,                 // clean HTML — used by mobile app
      version: doc.version,
      isPublished: doc.isPublished,
      updatedAt: doc.updatedAt,
    });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /config/legal/:type  (admin only) ───────────────────────────────────
const updateLegalByType = async (req, res, next) => {
  try {
    const { type } = req.params;
    let { title, content, version, isPublished } = req.body;

    if (!LEGAL_TYPES.includes(type)) {
      return error(res, `Unknown legal document type: ${type}`, 400);
    }
    if (!content) return error(res, "content is required", 400);

    // Clean up rich-editor HTML artifacts before saving
    content = content
      .replace(/&nbsp;/g, ' ')                          // replace all nbsp with spaces
      .replace(/<p>\s*<br\s*\/?>\s*<\/p>/gi, '')       // empty paragraphs
      .replace(/<p>\s*<\/p>/gi, '')                     // truly empty paragraphs
      .replace(/(<br\s*\/?>){3,}/gi, '<br><br>')        // excessive line breaks
      .trim();

    const doc = await LegalContent.findOneAndUpdate(
      { type },
      {
        $set: {
          content,
          title: title || LEGAL_TITLES[type] || type,
          ...(version && { version }),
          ...(isPublished !== undefined && { isPublished }),
        },
      },
      { new: true, upsert: true, runValidators: true },
    );

    return success(res, "Legal document updated", doc);
  } catch (err) {
    next(err);
  }
};

// ─── POST /config/support ─────────────────────────────────────────────────────
// Saves the ticket to DB. Attaches user ID if authenticated.
const submitSupport = async (req, res, next) => {
  try {
    const { name, email, message, subject } = req.body;

    if (!name || !email || !message || !subject) {
      return error(res, "name, email, subject and message are required", 400);
    }

    const ticket = await SupportTicket.create({
      user: req.user?._id ?? null,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      subject: subject.trim(),
      message: message.trim(),
    });

    return success(
      res,
      "Support request submitted. We will get back to you within 24 hours! 📩",
      {
        ticketId: ticket._id,
        status: ticket.status,
      },
    );
  } catch (err) {
    next(err);
  }
};

// ─── GET /config/faqs ────────────────────────────────────────────────────────
// Returns all active FAQs from DB, sorted by category order then item order.
const getFaqs = async (req, res, next) => {
  try {
    const faqs = await Faq.find({ isActive: true })
      .sort({ category: 1, order: 1 })
      .select("id category question answer");

    // Seed defaults if DB is empty
    if (faqs.length === 0) {
      const defaults = [
        {
          category: "Getting Started",
          order: 1,
          question: "How do I track my daily steps?",
          answer:
            "Athlofit automatically syncs with your phone's health data (HealthKit on iOS, Health Connect on Android). Open the Tracker tab to see your real-time step count. Make sure health permissions are granted in your phone's Settings.",
        },
        {
          category: "Getting Started",
          order: 2,
          question: "How do I set up my health profile?",
          answer:
            "Go to Account → Settings → Edit Profile to fill in your age, height, weight, blood type, and other metrics. A complete profile helps Athlofit provide more accurate calorie and BMI calculations.",
        },
        {
          category: "Coins & Rewards",
          order: 1,
          question: "How do I earn coins?",
          answer:
            "You earn coins by completing daily health goals: walk your daily step target, drink 2000ml of water, and maintain streaks. Coins can be spent in the Athlofit Shop.",
        },
        {
          category: "Coins & Rewards",
          order: 2,
          question: "What is the Referral Bonus?",
          answer:
            "Share your unique referral code with friends. When they sign up and apply your code, you earn bonus coins and they earn welcome coins. Go to Account → Refer & Earn to find your code.",
        },
        {
          category: "Coins & Rewards",
          order: 3,
          question: "How many coins can I earn per day?",
          answer:
            "You can earn up to 250 coins per day from daily health activity rewards. Streak milestone rewards and achievement bonuses are one-time and do not count toward the daily limit.",
        },
        {
          category: "Streaks & Badges",
          order: 1,
          question: "How do streaks work?",
          answer:
            "A streak is maintained when you meet your daily step goal on consecutive days. Missing a day resets your streak to zero. You earn badges at 1, 7, 15, and 30 days.",
        },
        {
          category: "Streaks & Badges",
          order: 2,
          question: "Where can I see my badges?",
          answer:
            "Go to Account → Achievements to see all your earned badges. The Streak screen (accessible from the Tracker) shows your current streak progress.",
        },
        {
          category: "Shop",
          order: 1,
          question: "How do I use coins to buy products?",
          answer:
            'Browse the Shop tab, add items to your cart, and during checkout select "Pay with Coins". The coin equivalent price is displayed on every product page.',
        },
        {
          category: "Shop",
          order: 2,
          question: "Can I cancel my order?",
          answer:
            'Yes, orders can be cancelled before they are shipped. Go to Account → My Orders, tap on the order, and select "Cancel Order". Coins spent will be refunded to your wallet.',
        },
        {
          category: "Account & Privacy",
          order: 1,
          question: "How do I change my unit system (metric/imperial)?",
          answer:
            "Go to Account → Settings and toggle between Metric (kg/cm) and Imperial (lbs/ft) under the Preferences section.",
        },
        {
          category: "Account & Privacy",
          order: 2,
          question: "How do I delete my account?",
          answer:
            'To request account deletion, contact us at support@athlofit.com with the subject "Account Deletion Request". We will process your request within 7 business days.',
        },
      ];

      const inserted = await Faq.insertMany(
        defaults.map((f, i) => ({ ...f, isActive: true })),
        { ordered: false },
      );
      return success(
        res,
        "FAQs fetched",
        inserted.map((f) => f.toJSON()),
      );
    }

    return success(res, "FAQs fetched", faqs);
  } catch (err) {
    next(err);
  }
};

// ─── Admin: FAQ CRUD ──────────────────────────────────────────────────────────

// POST /config/admin/faqs
const adminCreateFaq = async (req, res, next) => {
  try {
    const { category, question, answer, order } = req.body;
    if (!category || !question || !answer) {
      return error(res, "category, question and answer are required", 400);
    }
    const faq = await Faq.create({
      category,
      question,
      answer,
      order: order ?? 0,
    });
    return success(res, "FAQ created", faq, 201);
  } catch (err) {
    next(err);
  }
};

// PUT /config/admin/faqs/:id
const adminUpdateFaq = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { category, question, answer, order, isActive } = req.body;

    const faq = await Faq.findByIdAndUpdate(
      id,
      {
        $set: {
          ...(category && { category }),
          ...(question && { question }),
          ...(answer && { answer }),
          ...(order !== undefined && { order }),
          ...(isActive !== undefined && { isActive }),
        },
      },
      { new: true, runValidators: true },
    );

    if (!faq) return error(res, "FAQ not found", 404);
    return success(res, "FAQ updated", faq);
  } catch (err) {
    next(err);
  }
};

// DELETE /config/admin/faqs/:id  (soft delete)
const adminDeleteFaq = async (req, res, next) => {
  try {
    const faq = await Faq.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false } },
      { new: true },
    );
    if (!faq) return error(res, "FAQ not found", 404);
    return success(res, "FAQ deactivated", faq);
  } catch (err) {
    next(err);
  }
};

// ─── Admin: Support Tickets ───────────────────────────────────────────────────

// GET /config/admin/support-tickets?status=open&page=1&limit=20
const adminGetTickets = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = status ? { status } : {};
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, parseInt(limit));

    const [tickets, total] = await Promise.all([
      SupportTicket.find(filter)
        .populate("user", "name email avatarUrl")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
      SupportTicket.countDocuments(filter),
    ]);

    return success(res, "Support tickets fetched", {
      tickets,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /config/admin/support-tickets/:id
const adminUpdateTicket = async (req, res, next) => {
  try {
    const { status, adminNotes, adminReply } = req.body;

    const oldTicket = await SupportTicket.findById(req.params.id);
    if (!oldTicket) return error(res, "Ticket not found", 404);

    const oldStatus = oldTicket.status;

    const ticket = await SupportTicket.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          ...(status && { status }),
          ...(adminNotes !== undefined && { adminNotes }),
        },
      },
      { new: true },
    );

    // ── Notify the user about the update ─────────────────────────────────────
    const statusChanged = status && status !== oldStatus;
    const hasReply = adminReply?.trim();

    if (statusChanged || hasReply) {
      const statusLabels = {
        open: 'Open',
        in_progress: 'In Progress',
        resolved: 'Resolved',
        closed: 'Closed',
      };
      const newStatusLabel = statusLabels[ticket.status] || ticket.status;
      const shortId = ticket._id.toString().slice(-6).toUpperCase();

      // Push notification (only if the ticket was submitted by a logged-in user)
      if (ticket.user) {
        const { createNotification } = require("../utils/createNotification");
        createNotification(ticket.user, {
          type: 'SUPPORT',
          title: '📩 Support Ticket Updated',
          message: hasReply
            ? `Reply on ticket #${shortId}: "${adminReply.trim().slice(0, 80)}"`
            : `Your ticket #${shortId} status changed to: ${newStatusLabel}`,
          data: { screen: 'Support', ticketId: ticket._id.toString() },
        });
      }

      // Email notification (always — every ticket has an email)
      try {
        const { sendOtpEmail } = require("../utils/otp");
        const nodemailer = require("nodemailer");
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT) || 587,
          secure: Number(process.env.SMTP_PORT) === 465,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });

        const subject = hasReply
          ? `Re: ${ticket.subject} — Ticket #${shortId}`
          : `Your support ticket #${shortId} is now ${newStatusLabel}`;

        const body = [
          `Hi ${ticket.name},`,
          '',
          hasReply ? `We've replied to your support request:` : `Your support ticket status has been updated:`,
          '',
          `Subject: ${ticket.subject}`,
          `Status: ${newStatusLabel}`,
          ...(hasReply ? ['', `Admin reply:`, adminReply.trim()] : []),
          '',
          'If you have more questions, simply reply to this email or submit a new request.',
          '',
          '— Athlofit Support Team',
        ].join('\n');

        await transporter.sendMail({
          from: process.env.EMAIL_FROM || '"Athlofit" <noreply@athlofit.com>',
          to: ticket.email,
          subject,
          text: body,
        });
      } catch (emailErr) {
        // Non-critical — log but don't fail the request.
        console.error('[SupportTicket] Email notification failed:', emailErr.message);
      }
    }

    return success(res, "Ticket updated", ticket);
  } catch (err) {
    next(err);
  }
};

// ─── GET /config/check-version?platform=android&version=0.0.25 ───────────────
// Public endpoint. Returns update status for the given client version & platform.
// Response shape:
//   { updateRequired: boolean, updateType: 'force' | 'soft' | 'none', ... }
const checkVersion = async (req, res, next) => {
  try {
    const { platform, version } = req.query;

    if (!platform || !version) {
      return error(res, "platform and version query params are required", 400);
    }

    const validPlatforms = ["android", "ios"];
    if (!validPlatforms.includes(platform.toLowerCase())) {
      return error(res, "platform must be 'android' or 'ios'", 400);
    }

    const cfg = await getOrCreateConfig();
    const forceUpdateCfg = cfg.forceUpdate;

    // The decision lives in utils/versionGate so it can be unit-tested, and so
    // there is one version-comparison implementation rather than two that can
    // drift. The local copy this replaced parsed with a bare Number(), which
    // yields NaN on any non-numeric component — and every NaN comparison is
    // false, so an unparseable version fell through to "no update" by accident
    // rather than by decision. It also had no guard against a minVersion typo
    // hard-blocking users who were already on the newest build.
    const verdict = resolveUpdateRequirement(
      forceUpdateCfg,
      platform,
      version,
    );

    if (!verdict.updateRequired) {
      return success(res, "Version check passed", verdict);
    }

    return success(res, "Version check completed", {
      ...verdict,
      title: forceUpdateCfg.title || "Update Available",
      message:
        forceUpdateCfg.message ||
        "A new version of Athlofit is available. Please update for the best experience.",
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAppConfig,
  updateAppConfig,
  getCoinEconomy,
  getTerms,
  updateTerms,
  getPrivacy,
  updatePrivacy,
  getLegalList,
  getLegalByType,
  updateLegalByType,
  submitSupport,
  getFaqs,
  adminCreateFaq,
  adminUpdateFaq,
  adminDeleteFaq,
  adminGetTickets,
  adminUpdateTicket,
  checkVersion,
};
