const { success } = require('../utils/response');

// ─── GET /config/app ─────────────────────────────────────────────────────────
// Central runtime config consumed by the mobile app.
// Change these values here to roll out shop/coin config updates without a
// client deploy.
const getAppConfig = async (req, res, next) => {
  try {
    const config = {
      coin: {
        conversionRate: 10,    // 10 coins = ₹1
        dailyEarnLimit: 10,    // max coins earnable per day from steps
        coinsPerStepKm: 1,     // 1 coin per km walked
        purchaseEnabled: true, // coins-only shop is live
      },
      steps: {
        defaultDailyGoal: 8000,
        maxDailyGoal: 30000,
      },
      features: {
        shopEnabled: true,
        ordersEnabled: true,
        healthAnalyticsEnabled: true,
      },
    };
    return success(res, 'App config fetched', { config });
  } catch (err) {
    next(err);
  }
};

// ─── GET /config/terms ────────────────────────────────────────────────────────
const getTerms = async (req, res, next) => {
  try {
    const content = `
# Terms & Conditions

Welcome to Athlofit. By using our application, you agree to these terms.

## 1. User Account
You are responsible for maintaining the confidentiality of your account credentials.

## 2. Health Disclaimer
Athlofit provides health tracking and wellness information for informational purposes only. It is not a substitute for professional medical advice.

## 3. Data Usage
We collect health data to provide analytics and personalized tracking. Your data is stored securely.

## 4. Updates
We may update these terms from time to time. Your continued use of the app constitutes acceptance of the new terms.
    `;
    return success(res, 'Terms fetched', { content });
  } catch (err) {
    next(err);
  }
};

// ─── GET /config/privacy ──────────────────────────────────────────────────────
const getPrivacy = async (req, res, next) => {
  try {
    const content = `
# Privacy Policy

Your privacy is important to us.

## 1. Data Collection
We collect steps, hydration, and other health metrics you provide to visualize your progress.

## 2. Data Security
We use industry-standard encryption to protect your personal and health information.

## 3. Third-Party Sharing
We do not sell your personal data to third parties.

## 4. Your Rights
You can request to delete your account and associated data at any time through the app settings.
    `;
    return success(res, 'Privacy policy fetched', { content });
  } catch (err) {
    next(err);
  }
};

// ─── POST /config/support ─────────────────────────────────────────────────────
const submitSupport = async (req, res, next) => {
  try {
    const { name, email, message, subject } = req.body;
    
    // In a real app, this would send an email or save to a CRM/Database
    console.log('Support Request Received:', { name, email, message, subject });

    return success(res, 'Support request submitted. We will get back to you soon! 📩');
  } catch (err) {
    next(err);
  }
};

module.exports = { getTerms, getPrivacy, submitSupport, getAppConfig };

