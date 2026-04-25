// src/seedSynonyms.js
// ─── Seed multilingual food synonyms ─────────────────────────────────────────
// Run: node src/seedSynonyms.js

require('dotenv').config();
const mongoose    = require('mongoose');
const FoodSynonym = require('./models/FoodSynonym.model');

const SYNONYMS = [
  { canonical: 'banana',  aliases: ['kela', 'केला', 'platano', 'banan', 'banane'],        languages: ['hi', 'es', 'no', 'fr'] },
  { canonical: 'apple',   aliases: ['seb', 'सेब', 'manzana', 'pomme', 'apfel'],           languages: ['hi', 'es', 'fr', 'de'] },
  { canonical: 'mango',   aliases: ['aam', 'आम', 'mangue', 'mango'],                       languages: ['hi', 'fr'] },
  { canonical: 'rice',    aliases: ['chawal', 'चावल', 'arroz', 'riz', 'reis'],             languages: ['hi', 'es', 'fr', 'de'] },
  { canonical: 'chicken', aliases: ['murgi', 'मुर्गी', 'pollo', 'poulet', 'hähnchen'],    languages: ['hi', 'es', 'fr', 'de'] },
  { canonical: 'egg',     aliases: ['anda', 'अंडा', 'huevo', 'oeuf', 'ei'],               languages: ['hi', 'es', 'fr', 'de'] },
  { canonical: 'milk',    aliases: ['doodh', 'दूध', 'leche', 'lait', 'milch'],            languages: ['hi', 'es', 'fr', 'de'] },
  { canonical: 'potato',  aliases: ['aloo', 'आलू', 'papa', 'pomme de terre', 'kartoffel'], languages: ['hi', 'es', 'fr', 'de'] },
  { canonical: 'spinach', aliases: ['palak', 'पालक', 'espinaca', 'épinard'],              languages: ['hi', 'es', 'fr'] },
  { canonical: 'lentil',  aliases: ['dal', 'दाल', 'lenteja', 'lentille'],                 languages: ['hi', 'es', 'fr'] },
];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  for (const entry of SYNONYMS) {
    await FoodSynonym.findOneAndUpdate(
      { canonical: entry.canonical },
      { $set: entry },
      { upsert: true, new: true },
    );
    console.log(`✓ ${entry.canonical} → [${entry.aliases.join(', ')}]`);
  }

  console.log('\nSynonym seed complete.');
  await mongoose.disconnect();
}

seed().catch(err => { console.error(err); process.exit(1); });
