// src/verifySeedSetup.js
// ─── Verification script to check if all seed files are properly configured ──
// Run: node src/verifySeedSetup.js

const fs = require('fs');
const path = require('path');

const SEED_FILES = [
  'seedAll.js',
  'seedNutrition.js',
  'seedChallenges.js',
  'seedShop.js',
  'seedBadges.js',
  'seedSynonyms.js',
  'seedComplete.js',
];

const MODEL_FILES = [
  'User.model.js',
  'Gamification.model.js',
  'BadgeDefinition.model.js',
  'Challenge.model.js',
  'UserChallenge.model.js',
  'Food.model.js',
  'FoodSynonym.model.js',
  'MealLog.model.js',
  'NutritionPreference.model.js',
  'HealthActivity.model.js',
  'BmiRecord.model.js',
  'Category.model.js',
  'Product.model.js',
  'Order.model.js',
  'Achievement.model.js',
  'AppConfig.model.js',
  'Faq.model.js',
  'LegalContent.model.js',
  'Notification.model.js',
  'Referral.model.js',
  'RefreshToken.model.js',
  'SearchLog.model.js',
  'SupportTicket.model.js',
];

console.log('🔍 Verifying Seed Setup...\n');

let allGood = true;

// Check seed files
console.log('📄 Checking Seed Files:');
SEED_FILES.forEach(file => {
  const filePath = path.join(__dirname, file);
  const exists = fs.existsSync(filePath);
  const icon = exists ? '✅' : '❌';
  console.log(`  ${icon} ${file}`);
  if (!exists) allGood = false;
});

// Check model files
console.log('\n📦 Checking Model Files:');
MODEL_FILES.forEach(file => {
  const filePath = path.join(__dirname, 'models', file);
  const exists = fs.existsSync(filePath);
  const icon = exists ? '✅' : '❌';
  console.log(`  ${icon} models/${file}`);
  if (!exists) allGood = false;
});

// Check .env file
console.log('\n⚙️  Checking Configuration:');
const envPath = path.join(__dirname, '..', '.env');
const envExists = fs.existsSync(envPath);
const envIcon = envExists ? '✅' : '⚠️ ';
console.log(`  ${envIcon} .env file ${envExists ? 'exists' : 'missing (copy from .env.example)'}`);

// Check package.json scripts
console.log('\n📜 Checking NPM Scripts:');
const packagePath = path.join(__dirname, '..', 'package.json');
if (fs.existsSync(packagePath)) {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const scripts = packageJson.scripts || {};
  
  const requiredScripts = [
    'seed:all',
    'seed:nutrition',
    'seed:challenges',
    'seed:shop',
    'seed:badges',
    'seed:synonyms',
    'seed:complete',
  ];
  
  requiredScripts.forEach(script => {
    const exists = !!scripts[script];
    const icon = exists ? '✅' : '❌';
    console.log(`  ${icon} ${script}`);
    if (!exists) allGood = false;
  });
} else {
  console.log('  ❌ package.json not found');
  allGood = false;
}

// Check documentation
console.log('\n📚 Checking Documentation:');
const docs = [
  'README.md',
  'SEEDING_GUIDE.md',
  'SEED_DATA_SUMMARY.md',
  'QUICK_START.md',
];

docs.forEach(doc => {
  const docPath = path.join(__dirname, '..', doc);
  const exists = fs.existsSync(docPath);
  const icon = exists ? '✅' : '❌';
  console.log(`  ${icon} ${doc}`);
  if (!exists) allGood = false;
});

// Final verdict
console.log('\n' + '='.repeat(60));
if (allGood) {
  console.log('✅ ALL CHECKS PASSED!');
  console.log('='.repeat(60));
  console.log('\n🎉 Your seed setup is complete and ready to use!');
  console.log('\n📝 Next steps:');
  console.log('   1. Make sure MongoDB is running');
  console.log('   2. Configure your .env file');
  console.log('   3. Run: npm run seed:complete');
  console.log('   4. Start your server: npm start\n');
  process.exit(0);
} else {
  console.log('❌ SOME CHECKS FAILED!');
  console.log('='.repeat(60));
  console.log('\n⚠️  Please fix the issues above before running seeds.\n');
  process.exit(1);
}
