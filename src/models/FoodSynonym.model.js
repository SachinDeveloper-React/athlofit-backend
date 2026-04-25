// src/models/FoodSynonym.model.js
// ─── Multilingual / synonym mapping for food search ──────────────────────────
//
// Each document maps one or more alias terms to a canonical search term.
//
// Example document:
//   { canonical: 'banana', aliases: ['kela', 'केला', 'platano', 'banan'] }
//
// When a user searches for 'kela', the controller resolves it to 'banana'
// before hitting the Food text index, so results are language-agnostic.

const mongoose = require('mongoose');

const foodSynonymSchema = new mongoose.Schema(
  {
    // The authoritative English term used in the Food catalog
    canonical: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },

    // All alternative spellings / translations that should map to `canonical`
    aliases: [
      {
        type: String,
        trim: true,
        lowercase: true,
      },
    ],

    // Optional: language codes for the aliases (informational, not enforced)
    // e.g. ['hi', 'es', 'fr']
    languages: [{ type: String }],
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Index aliases for fast look-up
foodSynonymSchema.index({ aliases: 1 });

module.exports = mongoose.model('FoodSynonym', foodSynonymSchema);
