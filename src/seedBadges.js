// src/seedBadges.js
// Run with: node src/seedBadges.js
// Seeds all badge definitions. Safe to re-run — uses upsert ($setOnInsert)
// so it won't overwrite admin customizations on existing badges.

require('dotenv').config();
const mongoose = require('mongoose');
const BadgeDefinition = require('./models/BadgeDefinition.model');

const DEFAULT_BADGES = [
  // ─── Original 4 ───────────────────────────────────────────────────
  {
    key: 'starter',
    title: 'Starter',
    rule: '1 day streak',
    emoji: '🥉',
    color: '#cd7f32',
    threshold: 1,
    coinReward: 0,
    order: 0,
    isActive: true,
  },
  {
    key: 'consistent',
    title: 'Consistent',
    rule: '7 day streak',
    emoji: '🥈',
    color: '#aaaaaa',
    threshold: 7,
    coinReward: 200,
    order: 1,
    isActive: true,
  },
  {
    key: 'finisher',
    title: 'Finisher',
    rule: '15 day streak',
    emoji: '🥇',
    color: '#ffd700',
    threshold: 15,
    coinReward: 400,
    order: 2,
    isActive: true,
  },
  {
    key: 'elite',
    title: 'Elite',
    rule: '30 day streak',
    emoji: '👑',
    color: '#a855f7',
    threshold: 30,
    coinReward: 800,
    order: 3,
    isActive: true,
  },

  // ─── Extended milestones ───────────────────────────────────────────
  {
    key: 'champion',
    title: 'Champion',
    rule: '60 day streak',
    emoji: '🏆',
    color: '#f59e0b',
    threshold: 60,
    coinReward: 1500,
    order: 4,
    isActive: true,
  },
  {
    key: 'legend',
    title: 'Legend',
    rule: '90 day streak',
    emoji: '🔱',
    color: '#06b6d4',
    threshold: 90,
    coinReward: 2500,
    order: 5,
    isActive: true,
  },
  {
    key: 'titan',
    title: 'Titan',
    rule: '120 day streak',
    emoji: '⚡',
    color: '#3b82f6',
    threshold: 120,
    coinReward: 4000,
    order: 6,
    isActive: true,
  },
  {
    key: 'immortal',
    title: 'Immortal',
    rule: '180 day streak',
    emoji: '🔥',
    color: '#ef4444',
    threshold: 180,
    coinReward: 6000,
    order: 7,
    isActive: true,
  },
  {
    key: 'godlike',
    title: 'Godlike',
    rule: '250 day streak',
    emoji: '✨',
    color: '#8b5cf6',
    threshold: 250,
    coinReward: 10000,
    order: 8,
    isActive: true,
  },
];

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    for (const badge of DEFAULT_BADGES) {
      await BadgeDefinition.findOneAndUpdate(
        { key: badge.key },
        { $setOnInsert: badge }, // only insert, never overwrite admin changes
        { upsert: true, new: true }
      );
      console.log(`✓ "${badge.key}" (${badge.threshold}d) — upserted`);
    }

    const total = await BadgeDefinition.countDocuments();
    console.log(`\n✅ Badge seed complete! ${total} badges in DB.`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  }
}

seed();
