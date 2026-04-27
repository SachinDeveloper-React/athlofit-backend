// src/models/LegalContent.model.js
// ─── Stores Terms & Conditions and Privacy Policy as editable DB documents ───

const mongoose = require('mongoose');

const legalContentSchema = new mongoose.Schema(
  {
    // 'terms' | 'privacy'
    type:    { type: String, required: true, unique: true, enum: ['terms', 'privacy'] },
    title:   { type: String, required: true, trim: true },
    content: { type: String, required: true },
    version: { type: String, default: '1.0' },
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

module.exports = mongoose.model('LegalContent', legalContentSchema);
