// src/seed.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User.model');
const Gamification = require('./models/Gamification.model');

async function seed() {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/athlofit';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    await User.deleteMany();
    await Gamification.deleteMany();
    console.log('Cleared existing data');

    const user = await User.create({
      name: 'Test Setup',
      email: 'test@demo.com',
      password: 'Password123!',
      isProfileCompleted: true,
      age: 28,
      height: 180,
      weight: 75,
      gender: 'M',
      dailyStepGoal: 8000,
      emailVerified: true
    });
    console.log('Created User: test@demo.com / Password123!');

    const today = new Date().toISOString().split('T')[0];

    await Gamification.create({
      user: user._id,
      coinsBalance: 500,
      coinsEarnedToday: 50,
      streakDays: 14,
      bestStreakDays: 20,
      lastActiveDate: today,
      lastCoinDate: today,
      badges: {
        starter: { unlocked: true, unlockedAt: new Date() },
        consistent: { unlocked: true, unlockedAt: new Date() },
        finisher: { unlocked: false },
        elite: { unlocked: false },
      }
    });
    console.log('Created Gamification Profile');

    console.log('Seeding complete!');
    process.exit(0);
  } catch (err) {
    console.error('Error seeding data:', err);
    process.exit(1);
  }
}

seed();
