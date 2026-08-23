// src/routes/user.routes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const {
  getProfile,
  updateProfile,
  completeProfile,
  updateStepGoal,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  saveIncomingNotification,
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  uploadAvatar,
  updateFcmToken,
  exportMyData,
  emailMyData,
  getNotificationPreferences,
  updateNotificationPreferences,
  requestAccountDeletion,
  cancelAccountDeletion,
  getDeletionStatus,
  getBonusStepsHistory,
} = require("../controllers/user.controller");
const {
  getAnalyticsDashboard,
  syncAnalyticsDashboard,
} = require("../controllers/health.controller");
const { protect } = require("../middleware/auth.middleware");
const { body } = require("express-validator");
const { validate } = require("../middleware/validate.middleware");

// multer — memory storage, 5 MB limit, images only
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

const completeProfileRules = [
  body("phone").notEmpty().withMessage("Phone is required"),
  body("dob").isISO8601().withMessage("DOB must be a valid date"),
  body("gender").isIn(["M", "F", "O"]).withMessage("Gender must be M, F, or O"),
  body("height")
    .isFloat({ min: 50, max: 300 })
    .withMessage("Height must be 50–300 cm"),
  body("weight")
    .isFloat({ min: 10, max: 500 })
    .withMessage("Weight must be 10–500 kg"),
  body("bloodType").notEmpty().withMessage("Blood type is required"),
];

// All user routes require auth
router.use(protect);

router.get("/profile", getProfile);
router.patch("/profile", updateProfile);
router.post(
  "/complete-profile",
  completeProfileRules,
  validate,
  completeProfile,
);
router.patch("/step-goal", updateStepGoal);

// ─── Bonus steps history ──────────────────────────────────────────────────────
router.get("/bonus-steps", getBonusStepsHistory);

// ─── Avatar upload ────────────────────────────────────────────────────────────
router.post("/upload-avatar", avatarUpload.single("avatar"), uploadAvatar);

// ─── Analytics — aliased here so frontend's `user/analytics?period=X` works ──
router.get("/analytics", getAnalyticsDashboard);
router.post("/analytics/sync", syncAnalyticsDashboard);

// ─── In-app notifications ────────────────────────────────────────────────────
router.get("/notifications", getNotifications);
router.post("/notifications", saveIncomingNotification);
router.patch("/notifications/read-all", markAllNotificationsRead);
router.patch("/notifications/:id/read", markNotificationRead);
router.delete("/notifications/:id", deleteNotification);

// ─── FCM token ───────────────────────────────────────────────────────────────
router.patch("/fcm-token", updateFcmToken);

// ─── Delivery addresses ───────────────────────────────────────────────────────
router.get("/addresses", getAddresses);
router.post("/addresses", addAddress);
router.patch("/addresses/:addressId", updateAddress);
router.delete("/addresses/:addressId", deleteAddress);

// ─── Notification preferences ─────────────────────────────────────────────────
// Per-category push control. The master switch stays on PATCH /user/fcm-token
// for backwards compatibility; this endpoint also accepts `masterEnabled`.
router.get("/notification-preferences", getNotificationPreferences);
router.patch("/notification-preferences", updateNotificationPreferences);

// ─── Data export ──────────────────────────────────────────────────────────────
// Reads every collection this user appears in, so it is by far the most
// expensive endpoint here. Rate-limited hard: a genuine "download my data" is
// something a person does once, while an unthrottled one is a cheap way to pin
// the database. Keyed per user rather than per IP so one person on a shared
// network cannot exhaust everyone else's allowance.
const exportLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?._id || req.ip),
  message: {
    success: false,
    message: "Data export is limited to 3 requests per day. Please try again later.",
  },
});
router.get("/export-data", exportLimiter, exportMyData);
router.post("/export-data/email", exportLimiter, emailMyData);

// ─── Account deletion ─────────────────────────────────────────────────────────
router.post("/request-deletion", requestAccountDeletion);
router.post("/cancel-deletion", cancelAccountDeletion);
router.get("/deletion-status", getDeletionStatus);

module.exports = router;
