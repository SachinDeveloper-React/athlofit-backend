#!/usr/bin/env node
/**
 * debug-missing-steps.js
 * 
 * Diagnostic script to investigate why Aug 7, 2026 steps are showing as 0
 * when device shows 889 steps.
 * 
 * Run: node scripts/debug-missing-steps.js <user_email_or_id>
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User.model');
const HealthActivity = require('../src/models/HealthActivity.model');
const Gamification = require('../src/models/Gamification.model');
const CoinTransaction = require('../src/models/CoinTransaction.model');

const TARGET_DATE = '2026-08-07';
const TODAY = '2026-08-08';

async function main() {
  const userIdentifier = process.argv[2];
  
  if (!userIdentifier) {
    console.error('❌ Usage: node scripts/debug-missing-steps.js <user_email_or_id>');
    process.exit(1);
  }

  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find user
    const user = await User.findOne({
      $or: [
        { email: userIdentifier },
        { _id: mongoose.Types.ObjectId.isValid(userIdentifier) ? userIdentifier : null }
      ]
    });

    if (!user) {
      console.error(`❌ User not found: ${userIdentifier}`);
      process.exit(1);
    }

    console.log('👤 USER INFO');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`ID: ${user._id}`);
    console.log(`Email: ${user.email}`);
    console.log(`Name: ${user.fullName}`);
    console.log(`Account Created: ${user.createdAt}`);
    console.log(`Account Created Date (YYYY-MM-DD): ${new Date(user.createdAt).toISOString().slice(0, 10)}`);
    console.log(`Daily Step Goal: ${user.dailyStepGoal || 10000}`);
    console.log('');

    // Check if TARGET_DATE is before account creation
    const accountCreatedDate = new Date(user.createdAt).toISOString().slice(0, 10);
    if (TARGET_DATE < accountCreatedDate) {
      console.log(`⚠️  WARNING: ${TARGET_DATE} is BEFORE account creation (${accountCreatedDate})`);
      console.log(`   Backend guard would reject this sync!`);
      console.log('');
    }

    // Check HealthActivity records around Aug 7
    console.log('📊 HEALTH ACTIVITY RECORDS (Aug 6-8)');
    console.log('═══════════════════════════════════════════════════════════');
    const healthRecords = await HealthActivity.find({
      user: user._id,
      date: { $gte: '2026-08-06', $lte: '2026-08-08' }
    }).sort({ date: 1 });

    if (healthRecords.length === 0) {
      console.log('❌ No health records found for Aug 6-8');
    } else {
      healthRecords.forEach(record => {
        console.log(`\n📅 ${record.date}`);
        console.log(`   Steps: ${record.steps || 0} (Bonus: ${record.bonusSteps || 0})`);
        console.log(`   Distance: ${record.distance || 0} km`);
        console.log(`   Calories: ${record.calories || 0}`);
        console.log(`   Active Minutes: ${record.activeMinutes || 0}`);
        console.log(`   Goal Met: ${record.goalMet ? '✅' : '❌'}`);
        console.log(`   Goal Snapshot: ${record.goalSnapshot || 'N/A'}`);
        console.log(`   Created: ${record.createdAt}`);
        console.log(`   Last Updated: ${record.updatedAt}`);
      });
    }
    console.log('');

    // Check Gamification record
    console.log('🎮 GAMIFICATION DATA');
    console.log('═══════════════════════════════════════════════════════════');
    const gam = await Gamification.findOne({ user: user._id });
    
    if (!gam) {
      console.log('❌ No gamification record found');
    } else {
      console.log(`Coins Balance: ${gam.coinsBalance || 0}`);
      console.log(`Coins Earned Today: ${gam.coinsEarnedToday || 0}`);
      console.log(`Last Coin Date: ${gam.lastCoinDate || 'N/A'}`);
      console.log(`Step Goal Coin Date: ${gam.stepGoalCoinDate || 'N/A'}`);
      console.log(`Last Passive Coin Steps: ${gam.lastPassiveCoinSteps || 0}`);
      console.log(`Last Passive Coin Time: ${gam.lastPassiveCoinTime || 'N/A'}`);
      console.log(`Current Streak: ${gam.currentStreak || 0}`);
      console.log(`Last Active Date: ${gam.lastActiveDate || 'N/A'}`);
    }
    console.log('');

    // Check Coin Transactions for Aug 7
    console.log('💰 COIN TRANSACTIONS (Aug 7)');
    console.log('═══════════════════════════════════════════════════════════');
    const coinTxns = await CoinTransaction.find({
      user: user._id,
      'metadata.date': TARGET_DATE
    }).sort({ createdAt: 1 });

    if (coinTxns.length === 0) {
      console.log(`❌ No coin transactions found for ${TARGET_DATE}`);
    } else {
      coinTxns.forEach(txn => {
        console.log(`\n${txn.type} | ${txn.source}`);
        console.log(`   Amount: ${txn.amount}`);
        console.log(`   Balance After: ${txn.balanceAfter}`);
        console.log(`   Description: ${txn.description || 'N/A'}`);
        console.log(`   Metadata: ${JSON.stringify(txn.metadata || {})}`);
        console.log(`   Created: ${txn.createdAt}`);
      });
    }
    console.log('');

    // Check if there are ANY sync attempts logged (if you have sync logs)
    console.log('📝 DIAGNOSIS & RECOMMENDATIONS');
    console.log('═══════════════════════════════════════════════════════════');
    
    const aug7Record = healthRecords.find(r => r.date === TARGET_DATE);
    const aug8Record = healthRecords.find(r => r.date === TODAY);

    if (!aug7Record) {
      console.log(`❌ PROBLEM: No HealthActivity record exists for ${TARGET_DATE}`);
      console.log('');
      console.log('Possible causes:');
      console.log('1. Account creation date check:');
      if (TARGET_DATE < accountCreatedDate) {
        console.log('   ⚠️  CONFIRMED: Backend would reject sync (date < account creation)');
        console.log(`   Account created: ${accountCreatedDate}, Sync date: ${TARGET_DATE}`);
      } else {
        console.log('   ✅ Account creation check passed');
      }
      console.log('');
      console.log('2. EOD sync alarm issues:');
      console.log('   • Alarm may have fired after midnight (00:00+)');
      console.log('   • Native reset pending guard blocked the sync');
      console.log('   • Check device logs: adb logcat | grep "EodSyncWorker\\|HealthSyncHelper"');
      console.log('');
      console.log('3. Background sync stale data guards:');
      console.log('   • Post-midnight guard (< 5 min) with implausible steps (889 > 820 at 4min)');
      console.log('   • Fresh login guard (< 2 min after login)');
      console.log('   • Health data store not refreshed (lastFetchedAt stale)');
      console.log('');
      console.log('4. Network/server errors:');
      console.log('   • Sync request may have failed silently');
      console.log('   • Check server logs for sync attempts around midnight Aug 7→8');
    } else {
      console.log(`✅ HealthActivity record EXISTS for ${TARGET_DATE}`);
      console.log(`   Steps: ${aug7Record.steps}`);
      console.log('');
      if (aug7Record.steps === 0) {
        console.log('⚠️  BUT: Steps are 0 (should be 889)');
        console.log('Possible causes:');
        console.log('• Sync request sent 0 steps due to client-side reading error');
        console.log('• Health Connect read failed on that date');
        console.log('• Step deduplication logic filtered out all sources');
      }
    }

    if (aug8Record && aug8Record.steps > 0) {
      console.log(`\n✅ Aug 8 record exists with ${aug8Record.steps} steps`);
      console.log('   This confirms syncing is working today');
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');
  }
}

main();
