#!/usr/bin/env node
// src/seedComplete.js
// ─── Master seed orchestrator - runs all seeds in correct order ──────────────
// Run: node src/seedComplete.js or npm run seed:complete

require('dotenv').config();
const { execSync } = require('child_process');

const SEEDS = [
  { name: 'Nutrition Catalog', script: 'src/seedNutrition.js' },
  { name: 'Challenges', script: 'src/seedChallenges.js' },
  { name: 'Shop Data', script: 'src/seedShop.js' },
  { name: 'Food Synonyms', script: 'src/seedSynonyms.js' },
  { name: 'Badge Definitions', script: 'src/seedBadges.js' },
  { name: 'Core Data', script: 'src/seedAll.js' },
];

function runSeed(name, script) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🌱 Seeding: ${name}`);
  console.log('='.repeat(60));
  
  try {
    execSync(`node ${script}`, { stdio: 'inherit' });
    console.log(`✅ ${name} completed successfully`);
    return true;
  } catch (error) {
    console.error(`❌ ${name} failed:`, error.message);
    return false;
  }
}

async function seedComplete() {
  console.log('\n' + '█'.repeat(60));
  console.log('🚀 ATHLOFIT COMPLETE DATABASE SEED');
  console.log('█'.repeat(60));
  console.log('\nThis will seed all data in the correct order:');
  SEEDS.forEach((seed, i) => {
    console.log(`  ${i + 1}. ${seed.name}`);
  });
  console.log('\n⚠️  WARNING: This will delete all existing data!\n');
  
  const results = [];
  
  for (const seed of SEEDS) {
    const success = runSeed(seed.name, seed.script);
    results.push({ name: seed.name, success });
    
    if (!success) {
      console.log('\n❌ Seeding stopped due to error');
      process.exit(1);
    }
  }
  
  console.log('\n' + '█'.repeat(60));
  console.log('✅ ALL SEEDS COMPLETED SUCCESSFULLY!');
  console.log('█'.repeat(60));
  
  console.log('\n📊 Summary:');
  results.forEach((result, i) => {
    const icon = result.success ? '✅' : '❌';
    console.log(`  ${icon} ${i + 1}. ${result.name}`);
  });
  
  console.log('\n🔑 Test Credentials:');
  console.log('   User: john@example.com / Password123!');
  console.log('   User: jane@example.com / Password123!');
  console.log('   Admin: admin@athlofit.com / Admin123!');
  
  console.log('\n🎉 Your database is ready for development!');
  console.log('   Start your server: npm start\n');
}

seedComplete().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
