// src/seedAll.js
// ─── Master seed script for all database models ──────────────────────────────
// Run: node src/seedAll.js
// This script seeds all models with realistic sample data

require('dotenv').config();
const mongoose = require('mongoose');

// Import all models
const User = require('./models/User.model');
const Gamification = require('./models/Gamification.model');
const BadgeDefinition = require('./models/BadgeDefinition.model');
const Challenge = require('./models/Challenge.model');
const UserChallenge = require('./models/UserChallenge.model');
const Food = require('./models/Food.model');
const FoodSynonym = require('./models/FoodSynonym.model');
const MealLog = require('./models/MealLog.model');
const NutritionPreference = require('./models/NutritionPreference.model');
const HealthActivity = require('./models/HealthActivity.model');
const BmiRecord = require('./models/BmiRecord.model');
const Category = require('./models/Category.model');
const Product = require('./models/Product.model');
const Order = require('./models/Order.model');
const Achievement = require('./models/Achievement.model');
const AppConfig = require('./models/AppConfig.model');
const Faq = require('./models/Faq.model');
const LegalContent = require('./models/LegalContent.model');
const Notification = require('./models/Notification.model');
const Referral = require('./models/Referral.model');
const SupportTicket = require('./models/SupportTicket.model');

// ─── Helper Functions ─────────────────────────────────────────────────────────
const getDateString = (daysAgo = 0) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split('T')[0];
};

const getWeekKey = (daysAgo = 0) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const year = date.getFullYear();
  const week = Math.ceil(((date - new Date(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${week.toString().padStart(2, '0')}`;
};

// ─── Seed Functions ───────────────────────────────────────────────────────────

async function seedUsers() {
  console.log('\n📦 Seeding Users...');
  await User.deleteMany({});
  
  const users = await User.create([
    {
      name: 'John Doe',
      email: 'john@example.com',
      password: 'Password123!',
      provider: 'email',
      role: 'user',
      emailVerified: true,
      phoneVerified: true,
      isProfileCompleted: true,
      phone: '+1234567890',
      dob: '1995-05-15',
      gender: 'M',
      height: 180,
      weight: 75,
      age: 29,
      dailyStepGoal: 10000,
      unitSystem: 'metric',
      notificationsEnabled: true,
    },
    {
      name: 'Jane Smith',
      email: 'jane@example.com',
      password: 'Password123!',
      provider: 'email',
      role: 'user',
      emailVerified: true,
      phoneVerified: false,
      isProfileCompleted: true,
      phone: '+1234567891',
      dob: '1992-08-22',
      gender: 'F',
      height: 165,
      weight: 60,
      age: 32,
      dailyStepGoal: 8000,
      unitSystem: 'metric',
      notificationsEnabled: true,
    },
    {
      name: 'Admin User',
      email: 'admin@athlofit.com',
      password: 'Admin123!',
      provider: 'email',
      role: 'admin',
      emailVerified: true,
      phoneVerified: true,
      isProfileCompleted: true,
      phone: '+1234567892',
      dob: '1990-01-01',
      gender: 'M',
      height: 175,
      weight: 70,
      age: 34,
      dailyStepGoal: 12000,
      unitSystem: 'metric',
      notificationsEnabled: true,
    },
  ]);
  
  console.log(`✅ Created ${users.length} users`);
  return users;
}

async function seedGamification(users) {
  console.log('\n📦 Seeding Gamification...');
  await Gamification.deleteMany({});
  
  const today = getDateString();
  const gamifications = await Gamification.create([
    {
      user: users[0]._id,
      coinsBalance: 1250,
      coinsEarnedToday: 75,
      streakDays: 21,
      bestStreakDays: 30,
      lastActiveDate: today,
      lastCoinDate: today,
      badges: {
        starter: { unlocked: true, unlockedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) },
        consistent: { unlocked: true, unlockedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
        finisher: { unlocked: true, unlockedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000) },
        elite: { unlocked: false },
      },
    },
    {
      user: users[1]._id,
      coinsBalance: 850,
      coinsEarnedToday: 50,
      streakDays: 12,
      bestStreakDays: 15,
      lastActiveDate: today,
      lastCoinDate: today,
      badges: {
        starter: { unlocked: true, unlockedAt: new Date(Date.now() - 11 * 24 * 60 * 60 * 1000) },
        consistent: { unlocked: true, unlockedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
        finisher: { unlocked: false },
        elite: { unlocked: false },
      },
    },
    {
      user: users[2]._id,
      coinsBalance: 5000,
      coinsEarnedToday: 100,
      streakDays: 45,
      bestStreakDays: 45,
      lastActiveDate: today,
      lastCoinDate: today,
      badges: {
        starter: { unlocked: true, unlockedAt: new Date(Date.now() - 44 * 24 * 60 * 60 * 1000) },
        consistent: { unlocked: true, unlockedAt: new Date(Date.now() - 38 * 24 * 60 * 60 * 1000) },
        finisher: { unlocked: true, unlockedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        elite: { unlocked: true, unlockedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) },
      },
    },
  ]);
  
  console.log(`✅ Created ${gamifications.length} gamification profiles`);
  return gamifications;
}

async function seedBadgeDefinitions() {
  console.log('\n📦 Seeding Badge Definitions...');
  await BadgeDefinition.deleteMany({});
  
  const badges = [
    { key: 'starter', title: 'Starter', rule: '1 day streak', emoji: '🥉', color: '#cd7f32', threshold: 1, coinReward: 0, order: 0, isActive: true },
    { key: 'consistent', title: 'Consistent', rule: '7 day streak', emoji: '🥈', color: '#aaaaaa', threshold: 7, coinReward: 200, order: 1, isActive: true },
    { key: 'finisher', title: 'Finisher', rule: '15 day streak', emoji: '🥇', color: '#ffd700', threshold: 15, coinReward: 400, order: 2, isActive: true },
    { key: 'elite', title: 'Elite', rule: '30 day streak', emoji: '👑', color: '#a855f7', threshold: 30, coinReward: 800, order: 3, isActive: true },
    { key: 'champion', title: 'Champion', rule: '60 day streak', emoji: '🏆', color: '#f59e0b', threshold: 60, coinReward: 1500, order: 4, isActive: true },
    { key: 'legend', title: 'Legend', rule: '90 day streak', emoji: '🔱', color: '#06b6d4', threshold: 90, coinReward: 2500, order: 5, isActive: true },
  ];
  
  const created = await BadgeDefinition.insertMany(badges);
  console.log(`✅ Created ${created.length} badge definitions`);
  return created;
}

async function seedHealthActivities(users) {
  console.log('\n📦 Seeding Health Activities...');
  await HealthActivity.deleteMany({});
  
  const activities = [];
  
  // Create 30 days of health data for each user
  for (const user of users) {
    for (let i = 0; i < 30; i++) {
      const date = getDateString(i);
      const baseSteps = user.dailyStepGoal || 8000;
      const steps = Math.floor(baseSteps * (0.7 + Math.random() * 0.6)); // 70-130% of goal
      
      activities.push({
        user: user._id,
        date,
        steps,
        distance: (steps / 1300).toFixed(2), // ~1300 steps per km
        calories: Math.floor(steps * 0.04), // ~0.04 cal per step
        activeMinutes: Math.floor(30 + Math.random() * 60),
        heartRate: Math.floor(70 + Math.random() * 30),
        heartRateMin: Math.floor(60 + Math.random() * 10),
        heartRateMax: Math.floor(140 + Math.random() * 40),
        hydration: Math.floor(1500 + Math.random() * 1500), // 1500-3000ml
        sleepHours: (6 + Math.random() * 3).toFixed(1), // 6-9 hours
        weight: user.weight + (Math.random() - 0.5) * 2, // slight variation
        goalMet: steps >= baseSteps,
      });
    }
  }
  
  const created = await HealthActivity.insertMany(activities);
  console.log(`✅ Created ${created.length} health activity records`);
  return created;
}

async function seedBmiRecords(users) {
  console.log('\n📦 Seeding BMI Records...');
  await BmiRecord.deleteMany({});
  
  const records = [];
  
  // Create 10 BMI records for each user (weekly measurements)
  for (const user of users) {
    for (let i = 0; i < 10; i++) {
      const date = getDateString(i * 7);
      const weight = user.weight + (Math.random() - 0.5) * 5; // slight variation
      const height = user.height / 100; // convert cm to m
      const bmi = weight / (height * height);
      
      let category = 'normal';
      if (bmi < 18.5) category = 'underweight';
      else if (bmi >= 25 && bmi < 30) category = 'overweight';
      else if (bmi >= 30) category = 'obese';
      
      records.push({
        user: user._id,
        date,
        weight: parseFloat(weight.toFixed(1)),
        height: parseFloat(height.toFixed(2)),
        bmi: parseFloat(bmi.toFixed(1)),
        category,
      });
    }
  }
  
  const created = await BmiRecord.insertMany(records);
  console.log(`✅ Created ${created.length} BMI records`);
  return created;
}

async function seedNutritionPreferences(users) {
  console.log('\n📦 Seeding Nutrition Preferences...');
  await NutritionPreference.deleteMany({});
  
  const preferences = await NutritionPreference.create([
    {
      user: users[0]._id,
      dietPreference: 'non-veg',
      dietaryGoal: 'muscle_gain',
      calorieGoal: 2500,
      favourites: [],
    },
    {
      user: users[1]._id,
      dietPreference: 'veg',
      dietaryGoal: 'weight_loss',
      calorieGoal: 1800,
      favourites: [],
    },
    {
      user: users[2]._id,
      dietPreference: 'vegan',
      dietaryGoal: 'maintenance',
      calorieGoal: 2200,
      favourites: [],
    },
  ]);
  
  console.log(`✅ Created ${preferences.length} nutrition preferences`);
  return preferences;
}

async function seedMealLogs(users, foods) {
  console.log('\n📦 Seeding Meal Logs...');
  await MealLog.deleteMany({});
  
  if (!foods || foods.length === 0) {
    console.log('⚠️  No foods available, skipping meal logs');
    return [];
  }
  
  const mealTypes = ['breakfast', 'lunch', 'dinner', 'snacks'];
  const logs = [];
  
  // Create 7 days of meal logs for each user
  for (const user of users) {
    for (let day = 0; day < 7; day++) {
      const date = getDateString(day);
      
      // 2-4 meals per day
      const mealsToday = Math.floor(2 + Math.random() * 3);
      const selectedMeals = mealTypes.slice(0, mealsToday);
      
      for (const mealType of selectedMeals) {
        const food = foods[Math.floor(Math.random() * foods.length)];
        
        logs.push({
          user: user._id,
          mealType,
          date,
          foodRef: food._id,
          name: food.name,
          calories: food.calories,
          protein: food.protein,
          carbs: food.carbs,
          fat: food.fat,
          quantity: food.servingSize,
          unit: food.servingUnit,
        });
      }
    }
  }
  
  const created = await MealLog.insertMany(logs);
  console.log(`✅ Created ${created.length} meal logs`);
  return created;
}

async function seedNotifications(users) {
  console.log('\n📦 Seeding Notifications...');
  await Notification.deleteMany({});
  
  const notifications = [];
  const types = ['GOAL', 'HYDRATION', 'CHALLENGE', 'COIN', 'SECURITY'];
  const messages = {
    GOAL: ['🎯 You reached your daily step goal!', '👏 Great job! Goal achieved!', '🏆 Daily goal completed!'],
    HYDRATION: ['💧 Time to drink water!', '🌊 Stay hydrated!', '💦 Hydration reminder'],
    CHALLENGE: ['🏅 New challenge available!', '⭐ Challenge completed!', '🎖️ You earned a challenge reward!'],
    COIN: ['🪙 You earned 50 coins!', '💰 Coin reward unlocked!', '✨ Bonus coins added!'],
    SECURITY: ['🔒 New login detected', '🛡️ Password changed successfully', '✅ Account verified'],
  };
  
  for (const user of users) {
    // Create 5-10 notifications per user
    const count = Math.floor(5 + Math.random() * 6);
    for (let i = 0; i < count; i++) {
      const type = types[Math.floor(Math.random() * types.length)];
      const messageList = messages[type];
      const message = messageList[Math.floor(Math.random() * messageList.length)];
      
      notifications.push({
        user: user._id,
        type,
        title: type.charAt(0) + type.slice(1).toLowerCase(),
        message,
        data: {},
        read: Math.random() > 0.3, // 70% read
      });
    }
  }
  
  const created = await Notification.insertMany(notifications);
  console.log(`✅ Created ${created.length} notifications`);
  return created;
}

async function seedReferrals(users) {
  console.log('\n📦 Seeding Referrals...');
  await Referral.deleteMany({});
  
  // User 1 referred User 2
  const referral = await Referral.create({
    referrer: users[0]._id,
    referee: users[1]._id,
    referralCode: users[0].referralCode,
    referrerBonusAwarded: true,
    referrerBonus: 200,
    refereeBonusAwarded: true,
    refereeBonus: 100,
  });
  
  console.log(`✅ Created 1 referral`);
  return [referral];
}

async function seedAchievements() {
  console.log('\n📦 Seeding Achievements...');
  await Achievement.deleteMany({});
  
  const achievements = await Achievement.create([
    {
      key: 'first_10k_steps',
      title: 'First 10K Steps',
      description: 'Walk 10,000 steps in a single day',
      reward: 100,
      criteriaType: 'STEPS_DAILY',
      targetValue: 10000,
      icon: 'Award',
    },
    {
      key: 'total_100k_steps',
      title: '100K Steps Total',
      description: 'Walk a total of 100,000 steps',
      reward: 500,
      criteriaType: 'STEPS_TOTAL',
      targetValue: 100000,
      icon: 'Trophy',
    },
    {
      key: 'hydration_master',
      title: 'Hydration Master',
      description: 'Drink 50 liters of water total',
      reward: 300,
      criteriaType: 'WATER_TOTAL',
      targetValue: 50000,
      icon: 'Droplet',
    },
    {
      key: 'first_order',
      title: 'First Order',
      description: 'Place your first shop order',
      reward: 150,
      criteriaType: 'ORDERS_COUNT',
      targetValue: 1,
      icon: 'ShoppingBag',
    },
  ]);
  
  console.log(`✅ Created ${achievements.length} achievements`);
  return achievements;
}

async function seedAppConfig() {
  console.log('\n📦 Seeding App Config...');
  await AppConfig.deleteMany({});
  
  const config = await AppConfig.create({
    key: 'global',
    coin: {
      conversionRate: 10,
      dailyEarnLimit: 200,
      maxDailyRewards: 250,
      coinsPerStepKm: 1,
      purchaseEnabled: true,
      referrerBonus: 200,
      refereeBonus: 100,
    },
    steps: {
      defaultDailyGoal: 8000,
      maxDailyGoal: 30000,
    },
    rewards: {
      stepGoalCoins: 50,
      hydrationGoalCoins: 20,
      hydrationGoalMl: 2000,
    },
    features: {
      shopEnabled: true,
      ordersEnabled: true,
      healthAnalyticsEnabled: true,
      referralEnabled: true,
      leaderboardEnabled: true,
    },
    maintenance: {
      enabled: false,
      message: 'We are under maintenance. Back soon!',
    },
    support: {
      email: 'support@athlofit.com',
      website: 'www.athlofit.com/faq',
    },
  });
  
  console.log(`✅ Created app config`);
  return config;
}

async function seedFaqs() {
  console.log('\n📦 Seeding FAQs...');
  await Faq.deleteMany({});
  
  const faqs = await Faq.create([
    {
      category: 'General',
      question: 'What is AthloFit?',
      answer: 'AthloFit is a comprehensive fitness and health tracking app that helps you monitor your daily activities, nutrition, and wellness goals.',
      order: 1,
      isActive: true,
    },
    {
      category: 'General',
      question: 'How do I get started?',
      answer: 'Simply sign up with your email, complete your profile with basic health information, and start tracking your activities!',
      order: 2,
      isActive: true,
    },
    {
      category: 'Coins',
      question: 'How do I earn coins?',
      answer: 'You can earn coins by completing daily step goals, staying hydrated, completing challenges, and maintaining streaks.',
      order: 3,
      isActive: true,
    },
    {
      category: 'Coins',
      question: 'What can I do with coins?',
      answer: 'Coins can be used to purchase products from our shop, including fitness equipment, supplements, and apparel.',
      order: 4,
      isActive: true,
    },
    {
      category: 'Health',
      question: 'How accurate is the step tracking?',
      answer: 'We integrate with Apple Health and Google Fit to provide the most accurate step tracking available on your device.',
      order: 5,
      isActive: true,
    },
    {
      category: 'Nutrition',
      question: 'Can I log custom meals?',
      answer: 'Yes! You can log meals from our extensive food catalog or create custom entries with your own nutritional information.',
      order: 6,
      isActive: true,
    },
  ]);
  
  console.log(`✅ Created ${faqs.length} FAQs`);
  return faqs;
}

async function seedLegalContent() {
  console.log('\n📦 Seeding Legal Content...');
  await LegalContent.deleteMany({});
  
  const legal = await LegalContent.create([
    {
      type: 'terms',
      title: 'Terms and Conditions',
      content: `# Terms and Conditions

Last updated: ${new Date().toLocaleDateString()}

## 1. Acceptance of Terms
By accessing and using AthloFit, you accept and agree to be bound by the terms and provision of this agreement.

## 2. Use License
Permission is granted to temporarily use AthloFit for personal, non-commercial transitory viewing only.

## 3. User Account
You are responsible for maintaining the confidentiality of your account and password.

## 4. Privacy
Your use of AthloFit is also governed by our Privacy Policy.

## 5. Modifications
AthloFit may revise these terms of service at any time without notice.`,
      version: '1.0',
    },
    {
      type: 'privacy',
      title: 'Privacy Policy',
      content: `# Privacy Policy

Last updated: ${new Date().toLocaleDateString()}

## 1. Information We Collect
We collect information you provide directly to us, including name, email, health data, and activity information.

## 2. How We Use Your Information
We use the information we collect to provide, maintain, and improve our services.

## 3. Information Sharing
We do not share your personal information with third parties except as described in this policy.

## 4. Data Security
We take reasonable measures to help protect your personal information from loss, theft, misuse, and unauthorized access.

## 5. Your Rights
You have the right to access, update, or delete your personal information at any time.`,
      version: '1.0',
    },
  ]);
  
  console.log(`✅ Created ${legal.length} legal documents`);
  return legal;
}

async function seedSupportTickets(users) {
  console.log('\n📦 Seeding Support Tickets...');
  await SupportTicket.deleteMany({});
  
  const tickets = await SupportTicket.create([
    {
      user: users[0]._id,
      name: users[0].name,
      email: users[0].email,
      subject: 'Unable to sync health data',
      message: 'My step count is not syncing properly from Apple Health. Can you help?',
      status: 'in_progress',
      adminNotes: 'Investigating sync issue',
    },
    {
      user: users[1]._id,
      name: users[1].name,
      email: users[1].email,
      subject: 'Question about coin rewards',
      message: 'How long does it take for challenge rewards to appear in my account?',
      status: 'resolved',
      adminNotes: 'Explained reward timing - instant upon completion',
    },
    {
      user: null,
      name: 'Guest User',
      email: 'guest@example.com',
      subject: 'Pre-sale question',
      message: 'Do you ship internationally?',
      status: 'open',
      adminNotes: '',
    },
  ]);
  
  console.log(`✅ Created ${tickets.length} support tickets`);
  return tickets;
}

// ─── Main Seed Function ───────────────────────────────────────────────────────

async function seedAll() {
  try {
    console.log('🌱 Starting comprehensive database seed...\n');
    console.log('📡 Connecting to MongoDB...');
    
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');
    
    // Seed in order (respecting dependencies)
    const users = await seedUsers();
    await seedGamification(users);
    await seedBadgeDefinitions();
    await seedHealthActivities(users);
    await seedBmiRecords(users);
    await seedNutritionPreferences(users);
    
    // Check if foods exist (from seedNutrition.js)
    const foods = await Food.find({});
    if (foods.length > 0) {
      console.log(`\n📦 Found ${foods.length} existing foods`);
      await seedMealLogs(users, foods);
    } else {
      console.log('\n⚠️  No foods found. Run seedNutrition.js first to seed meal logs.');
    }
    
    // Check if challenges exist (from seedChallenges.js)
    const challenges = await Challenge.find({});
    if (challenges.length > 0) {
      console.log(`\n📦 Found ${challenges.length} existing challenges`);
    } else {
      console.log('\n⚠️  No challenges found. Run seedChallenges.js to seed challenges.');
    }
    
    // Check if shop data exists (from seedShop.js)
    const categories = await Category.find({});
    const products = await Product.find({});
    if (categories.length > 0 && products.length > 0) {
      console.log(`\n📦 Found ${categories.length} categories and ${products.length} products`);
    } else {
      console.log('\n⚠️  No shop data found. Run seedShop.js to seed categories and products.');
    }
    
    await seedNotifications(users);
    await seedReferrals(users);
    await seedAchievements();
    await seedAppConfig();
    await seedFaqs();
    await seedLegalContent();
    await seedSupportTickets(users);
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ DATABASE SEED COMPLETE!');
    console.log('='.repeat(60));
    console.log('\n📊 Summary:');
    console.log(`   Users: ${await User.countDocuments()}`);
    console.log(`   Gamification Profiles: ${await Gamification.countDocuments()}`);
    console.log(`   Badge Definitions: ${await BadgeDefinition.countDocuments()}`);
    console.log(`   Health Activities: ${await HealthActivity.countDocuments()}`);
    console.log(`   BMI Records: ${await BmiRecord.countDocuments()}`);
    console.log(`   Nutrition Preferences: ${await NutritionPreference.countDocuments()}`);
    console.log(`   Meal Logs: ${await MealLog.countDocuments()}`);
    console.log(`   Foods: ${await Food.countDocuments()}`);
    console.log(`   Food Synonyms: ${await FoodSynonym.countDocuments()}`);
    console.log(`   Challenges: ${await Challenge.countDocuments()}`);
    console.log(`   Categories: ${await Category.countDocuments()}`);
    console.log(`   Products: ${await Product.countDocuments()}`);
    console.log(`   Notifications: ${await Notification.countDocuments()}`);
    console.log(`   Referrals: ${await Referral.countDocuments()}`);
    console.log(`   Achievements: ${await Achievement.countDocuments()}`);
    console.log(`   FAQs: ${await Faq.countDocuments()}`);
    console.log(`   Legal Documents: ${await LegalContent.countDocuments()}`);
    console.log(`   Support Tickets: ${await SupportTicket.countDocuments()}`);
    
    console.log('\n🔑 Test Credentials:');
    console.log('   User: john@example.com / Password123!');
    console.log('   User: jane@example.com / Password123!');
    console.log('   Admin: admin@athlofit.com / Admin123!');
    
    console.log('\n💡 Next Steps:');
    console.log('   1. Run: node src/seedNutrition.js (if not already done)');
    console.log('   2. Run: node src/seedChallenges.js (if not already done)');
    console.log('   3. Run: node src/seedShop.js (if not already done)');
    console.log('   4. Run: node src/seedSynonyms.js (if not already done)');
    console.log('   5. Start your server: npm start\n');
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Seed failed:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the seed
seedAll();
