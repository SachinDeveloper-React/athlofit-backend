// src/models/LegalContent.model.js
// ─── Stores all editable legal / policy documents as DB records ──────────────
// Each document is identified by a unique `type`. Content is markdown.

const mongoose = require('mongoose');

// All supported legal/policy document types.
// Add new types here to expose them on the website + admin automatically.
const LEGAL_TYPES = [
  'terms',                 // Terms & Conditions
  'privacy',               // Privacy Policy
  'coin-earning',          // Coin Earning & Rewards Policy
  'coin-redemption',       // Coin Redemption Policy
  'community-guidelines',  // Community Guidelines
  'data-deletion',         // Data Deletion Policy
  'medical-disclaimer',    // Medical / Fitness Disclaimer
  'refund',                // Refund & Cancellation Policy
];

const legalContentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      unique: true,
      enum: LEGAL_TYPES,
    },
    title: { type: String, required: true, trim: true },
    content: { type: String, required: true },
    version: { type: String, default: '1.0' },
    // Controls visibility on the public website
    isPublished: { type: Boolean, default: true },
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

legalContentSchema.statics.LEGAL_TYPES = LEGAL_TYPES;

module.exports = mongoose.model('LegalContent', legalContentSchema);
module.exports.LEGAL_TYPES = LEGAL_TYPES;
