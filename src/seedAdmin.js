// src/seedAdmin.js
// ─── Safe, non-destructive admin user seeder ─────────────────────────────────
// Creates (or updates) a single admin account without touching any other data.
// Run: node src/seedAdmin.js
//
// Override defaults with env vars:
//   ADMIN_EMAIL=you@domain.com ADMIN_PASSWORD=YourPass123! node src/seedAdmin.js

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User.model');
const Gamification = require('./models/Gamification.model');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@athlofit.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin123!';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Admin User';

async function run() {
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI is not set in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB connected');

  let admin = await User.findOne({ email: ADMIN_EMAIL }).select('+password');

  if (admin) {
    // Update existing user → ensure admin role + reset password + verified flags
    admin.role = 'admin';
    admin.password = ADMIN_PASSWORD; // pre-save hook re-hashes
    admin.emailVerified = true;
    admin.phoneVerified = true;
    admin.provider = 'email';
    await admin.save();
    console.log(`♻️  Updated existing user → admin: ${ADMIN_EMAIL}`);
  } else {
    admin = await User.create({
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      provider: 'email',
      role: 'admin',
      emailVerified: true,
      phoneVerified: true,
      isProfileCompleted: true,
    });
    console.log(`✨ Created new admin: ${ADMIN_EMAIL}`);
  }

  // Ensure a gamification record exists (some flows expect it)
  await Gamification.findOneAndUpdate(
    { user: admin._id },
    { user: admin._id },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  console.log('\n🔑 Admin credentials:');
  console.log(`   Email:    ${ADMIN_EMAIL}`);
  console.log(`   Password: ${ADMIN_PASSWORD}`);
  console.log('\n✅ Done. You can now log in to the admin panel.');

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
