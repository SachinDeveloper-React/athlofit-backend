// src/models/User.model.js
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// ─── Helper: generate unique 8-char alphanumeric referral code ────────────────
const generateReferralCode = () =>
  crypto.randomBytes(4).toString("hex").toUpperCase();

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      maxlength: [100, "Name cannot exceed 100 characters"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email"],
    },
    password: {
      type: String,
      minlength: [8, "Password must be at least 8 characters"],
      select: false,
    },
    provider: {
      type: String,
      enum: ["email", "google", "apple"],
      default: "email",
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },
    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },
    isProfileCompleted: { type: Boolean, default: false },

    // Profile fields
    phone: { type: String, default: null },
    dob: { type: String, default: null }, // ISO date "YYYY-MM-DD"
    gender: { type: String, enum: ["M", "F", "O"], default: null }, // BUG-037: null removed from enum
    height: { type: Number, default: null }, // cm
    weight: { type: Number, default: null }, // kg
    bloodType: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    age: { type: Number, default: null },

    // Unit system preference
    unitSystem: {
      type: String,
      enum: ["metric", "imperial"],
      default: "metric",
    },
    heightUnit: {
      type: String,
      enum: ["cm", "ft"],
      default: "cm",
    },
    weightUnit: {
      type: String,
      enum: ["kg", "lbs"],
      default: "kg",
    },

    // Google OAuth
    googleId: { type: String, default: null, sparse: true },
    googleScopes: { type: [String], default: [] }, // granted OAuth scopes
    givenName: { type: String, default: null },
    familyName: { type: String, default: null },

    // Referral
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Health goal
    dailyStepGoal: { type: Number, default: 10000 },
    // Pending goal — applied on the effective date so today's challenges
    // continue using the current goal until midnight.
    pendingStepGoal: { type: Number, default: null },
    pendingGoalEffectiveDate: { type: String, default: null }, // ISO "YYYY-MM-DD"
    // Tracks when the user last changed their step goal (ISO "YYYY-MM-DD").
    // Used for tracking/analytics purposes only (no cooldown enforcement).
    lastStepGoalChangeDate: { type: String, default: null },

    // Saved delivery addresses
    savedAddresses: [
      {
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
        label: { type: String, default: "Home" }, // "Home", "Work", "Other"
        fullName: { type: String, default: "" },
        phone: { type: String, default: "" },
        street: { type: String, default: "" },
        city: { type: String, default: "" },
        state: { type: String, default: "" },
        zipCode: { type: String, default: "" },
        country: { type: String, default: "India" },
        isDefault: { type: Boolean, default: false },
      },
    ],

    // OTP fields
    otp: { type: String, select: false },
    otpExpires: { type: Date, select: false },
    otpFlow: {
      type: String,
      enum: ["signup", "forgot_password", "phone_verify", null],
      select: false,
      default: null,
    },

    // Token versioning (for invalidation)
    tokenVersion: { type: Number, default: 0 },

    // ─── Account ban / suspension ───────────────────────────────────────────
    isBanned: { type: Boolean, default: false },
    banInfo: {
      reason: { type: String, default: null },
      bannedAt: { type: Date, default: null },
      bannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },

    // ─── Anti-cheat: coin block penalty ─────────────────────────────────────
    // When set, user cannot earn/claim coins until this date passes.
    // Triggered when step fraud is detected 3+ times in a single day.
    coinBlockedUntil: { type: Date, default: null },

    // FCM push notification token
    fcmToken: { type: String, default: null },
    // Master switch. Off means no pushes at all, including account-critical
    // ones — see utils/notificationPrefs.js for why that is deliberate.
    notificationsEnabled: { type: Boolean, default: true },

    // ─── Per-category push preferences ──────────────────────────────────────
    //
    // All default true: every existing user predates this field, and reading
    // absence as "off" would mute the entire user base on deploy.
    //
    // Only categories a user may reasonably not want are here. SECURITY,
    // SYSTEM, GENERAL and SUPPORT are deliberately absent — they carry things
    // needed to understand your own account (step tracking paused, deletion
    // scheduled, banned, a reply to a ticket you opened), and being able to
    // mute those while keeping the fun ones is the failure the single boolean
    // had: silencing nudge spam also silenced the step-pause notice.
    notificationPrefs: {
      goal: { type: Boolean, default: true },
      hydration: { type: Boolean, default: true },
      streak: { type: Boolean, default: true },
      challenge: { type: Boolean, default: true },
      coin: { type: Boolean, default: true },
      product: { type: Boolean, default: true },
      heart: { type: Boolean, default: true },
    },
    // Device platform — set when FCM token is registered
    platform: { type: String, enum: ["ios", "android", null], default: null },

    // ─── Step tracking kill switch (admin-controlled, per user) ─────────────
    //
    // Exists because a device can be a bad data source without its owner being
    // a bad actor — a broken sensor, a third-party app writing inflated
    // StepsRecords, an old build with a counting bug. Banning the account is
    // far too blunt for that: the user should keep their shop, hydration,
    // meals and challenges while their step pipeline is switched off.
    //
    // When disabled: POST /health/sync returns 403 STEPS_TRACKING_DISABLED, no
    // passive or goal coins are awarded, and the client stops its native step
    // service and shows a warning instead of a live count.
    stepsTracking: {
      enabled: { type: Boolean, default: true },
      // Shown verbatim to the user in the in-app warning, so write it for them.
      reason: { type: String, default: null },
      disabledAt: { type: Date, default: null },
      disabledBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      enabledAt: { type: Date, default: null },
      enabledBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
    },

    // ─── Device / app-build telemetry ───────────────────────────────────────
    //
    // Populated from the X-App-* request headers every authenticated request
    // sends (see deviceContext.middleware.js). Without this there is no way to
    // tell whether a user has installed a released fix, so a bug report can
    // never be tied to the build that produced it.
    device: {
      appVersion: { type: String, default: null }, // "1.72" — CFBundleShortVersionString / versionName
      buildNumber: { type: Number, default: null }, // 72 — CFBundleVersion / versionCode
      platform: { type: String, enum: ["ios", "android", null], default: null },
      osVersion: { type: String, default: null }, // "14" / "17.5"
      model: { type: String, default: null }, // "Pixel 7"
      manufacturer: { type: String, default: null }, // "Google"
      // Stable per-install id. Lets two devices on one account be told apart,
      // and survives app restarts without identifying the person.
      installId: { type: String, default: null },
      // Which code path last reported: 'app' (JS), 'native_service', 'worker'.
      lastSource: { type: String, default: null },
      lastSeenAt: { type: Date, default: null },
      // The build the account was first seen on — the "did they ever update?"
      // baseline, unchanged by later upgrades.
      firstSeenVersion: { type: String, default: null },
    },

    // ─── Verbose sync tracing (admin-controlled, per user) ──────────────────
    //
    // When on, EVERY /health/sync from this account is written to SyncLog, not
    // just the anomalous ones. For the case that actually happens: one user
    // reports wrong steps and you need the full trail of what their device
    // sent, rather than only the syncs the validator happened to find odd.
    //
    // Always expires. Left on indefinitely this is "log everything forever" for
    // that account, and nobody remembers to switch it back off.
    syncDebug: {
      enabled: { type: Boolean, default: false },
      enabledAt: { type: Date, default: null },
      enabledBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      expiresAt: { type: Date, default: null },
    },

    // Append-only trail of build changes on this account, newest last.
    // Capped in the middleware so it cannot grow without bound. This is what
    // answers "when did this user actually take the update?".
    deviceHistory: {
      type: [
        {
          _id: false,
          appVersion: { type: String, default: null },
          buildNumber: { type: Number, default: null },
          platform: { type: String, default: null },
          osVersion: { type: String, default: null },
          model: { type: String, default: null },
          installId: { type: String, default: null },
          seenAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    // Activity tracking (for inactivity expiry)
    lastActiveAt: { type: Date, default: Date.now },
    // Timestamp of the most recent successful login (used by anti-stale-sync guard)
    lastLoginAt: { type: Date, default: null },
    // Terms & Conditions acceptance
    termsAccepted: { type: Boolean, default: false },
    termsAcceptedAt: { type: Date, default: null },

    // Account deletion request
    deletionRequest: {
      type: {
        status: {
          type: String,
          enum: ["none", "pending", "in_progress", "completed", "cancelled"],
          default: "none",
        },
        requestedAt: { type: Date, default: null },
        scheduledDeletionDate: { type: Date, default: null }, // 30 days from request
        reason: { type: String, default: null },
        cancelledAt: { type: Date, default: null },
        completedAt: { type: Date, default: null },
        // Why a due request was not acted on by the deletion job — an admin
        // account, or orders still in flight whose shipping address the purge
        // would redact. Held rather than dropped, and surfaced through
        // GET /admin/deletions so a stuck request is visible instead of
        // looking like the job silently skipped someone.
        blockedReason: { type: String, default: null },
      },
      default: () => ({
        status: "none",
        requestedAt: null,
        scheduledDeletionDate: null,
        reason: null,
        cancelledAt: null,
        completedAt: null,
        blockedReason: null,
      }),
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.password;
        delete ret.otp;
        delete ret.otpExpires;
        delete ret.otpFlow;
        delete ret.tokenVersion;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// ─── Indexes ─────────────────────────────────────────────────────────────────
// Admin dashboards slice the user base by installed build ("who is still on
// 1.71?") and list everyone whose step tracking is switched off. Both are
// full-collection scans without an index.
userSchema.index({ "device.appVersion": 1 });
// The deletion job scans daily for requests whose grace period has expired.
userSchema.index({
  "deletionRequest.status": 1,
  "deletionRequest.scheduledDeletionDate": 1,
});
userSchema.index({ "stepsTracking.enabled": 1 });

// ─── Pre-save hook: hash password + auto-generate referral code ──────────────
userSchema.pre("save", async function (next) {
  // Hash password if modified
  if (this.isModified("password") && this.password) {
    this.password = await bcrypt.hash(this.password, 12);
  }
  // Auto-generate referral code on first save
  if (!this.referralCode) {
    this.referralCode = generateReferralCode();
  }
  next();
});

// ─── Method: compare password ─────────────────────────────────────────────────
userSchema.methods.comparePassword = async function (candidate) {
  // BUG-038: OAuth users have no password — guard against bcrypt TypeError
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model("User", userSchema);
