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

// ─── GET /config/faqs ────────────────────────────────────────────────────────
const getFaqs = async (req, res, next) => {
  try {
    const faqs = [
      {
        id: 'faq_1',
        category: 'Getting Started',
        question: 'How do I track my daily steps?',
        answer: 'Athlofit automatically syncs with your phone\'s health data (HealthKit on iOS, Health Connect on Android). Open the Tracker tab to see your real-time step count. Make sure health permissions are granted in your phone\'s Settings.',
      },
      {
        id: 'faq_2',
        category: 'Getting Started',
        question: 'How do I set up my health profile?',
        answer: 'Go to Account → Settings → Edit Profile to fill in your age, height, weight, blood type, and other metrics. A complete profile helps Athlofit provide more accurate calorie and BMI calculations.',
      },
      {
        id: 'faq_3',
        category: 'Coins & Rewards',
        question: 'How do I earn coins?',
        answer: 'You earn coins by completing daily health goals: walk your daily step target (50 coins), drink 2000ml of water (20 coins), and maintain streaks (up to 800 coins for a 30-day streak). Coins can be spent in the Athlofit Shop.',
      },
      {
        id: 'faq_4',
        category: 'Coins & Rewards',
        question: 'What is the Referral Bonus?',
        answer: 'Share your unique referral code with friends. When they sign up and apply your code, you earn 100 bonus coins and they earn 50 welcome coins. Go to Account → Refer & Earn to find your code.',
      },
      {
        id: 'faq_5',
        category: 'Coins & Rewards',
        question: 'How many coins can I earn per day?',
        answer: 'You can earn up to 250 coins per day from daily health activity rewards. Streak milestone rewards and achievement bonuses are one-time and do not count toward the daily limit.',
      },
      {
        id: 'faq_6',
        category: 'Streaks & Badges',
        question: 'How do streaks work?',
        answer: 'A streak is maintained when you meet your daily step goal on consecutive days. Missing a day resets your streak to zero. You earn badges at 1 day (Starter), 7 days (Consistent), 15 days (Finisher), and 30 days (Elite).',
      },
      {
        id: 'faq_7',
        category: 'Streaks & Badges',
        question: 'Where can I see my badges?',
        answer: 'Go to Account → Achievements to see all your earned badges and advanced achievements. The Streak screen (accessible from the Tracker) shows your current streak progress.',
      },
      {
        id: 'faq_8',
        category: 'Shop',
        question: 'How do I use coins to buy products?',
        answer: 'Browse the Shop tab, add items to your cart, and during checkout select "Pay with Coins". The coin equivalent price is displayed on every product page. Make sure you have enough coins in your wallet.',
      },
      {
        id: 'faq_9',
        category: 'Shop',
        question: 'Can I cancel my order?',
        answer: 'Yes, orders can be cancelled before they are shipped. Go to Account → My Orders, tap on the order, and select "Cancel Order". Coins spent will be refunded to your wallet.',
      },
      {
        id: 'faq_10',
        category: 'Account & Privacy',
        question: 'How do I change my unit system (metric/imperial)?',
        answer: 'Go to Account → Settings and toggle between Metric (kg/cm) and Imperial (lbs/ft) under the Preferences section. This affects how your weight and height are displayed throughout the app.',
      },
      {
        id: 'faq_11',
        category: 'Account & Privacy',
        question: 'How do I delete my account?',
        answer: 'To request account deletion, please contact us at support@athlofit.com with the subject "Account Deletion Request". We will process your request within 7 business days and permanently remove all your data.',
      },
    ];

    return success(res, 'FAQs fetched', faqs);
  } catch (err) {
    next(err);
  }
};

module.exports = { getTerms, getPrivacy, submitSupport, getAppConfig, getFaqs };

