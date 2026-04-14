// src/models/Faq.model.js
// ─── Stores FAQ entries editable from the admin panel ────────────────────────

const mongoose = require('mongoose');

const faqSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, trim: true },
    question: { type: String, required: true, trim: true },
    answer:   { type: String, required: true, trim: true },
    order:    { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

faqSchema.index({ category: 1, order: 1 });

module.exports = mongoose.model('Faq', faqSchema);
