// src/models/Blog.model.js
// ─── Blog posts managed from the admin panel, served to the public website ───

const mongoose = require('mongoose');

// Slugify helper — converts a title to a URL-safe slug.
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

const blogSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, unique: true, index: true },
    excerpt: { type: String, trim: true, default: '' },
    // Markdown / HTML body content
    content: { type: String, required: true },
    coverImage: { type: String, default: '' },
    category: { type: String, trim: true, default: 'General' },
    tags: [{ type: String, trim: true }],
    author: { type: String, trim: true, default: 'Athlofit Team' },

    // SEO fields (override defaults when provided)
    metaTitle: { type: String, trim: true, default: '' },
    metaDescription: { type: String, trim: true, default: '' },

    isPublished: { type: Boolean, default: false, index: true },
    publishedAt: { type: Date, default: null },
    readTime: { type: Number, default: 0 }, // minutes
    views: { type: Number, default: 0 },
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

// Auto-generate slug from title and compute read time before validation.
blogSchema.pre('validate', function (next) {
  if (this.isModified('title') || !this.slug) {
    let baseSlug = slugify(this.title);
    // Append short random suffix to reduce collisions on duplicate titles
    if (this.isNew) {
      baseSlug = `${baseSlug}-${Math.random().toString(36).slice(2, 7)}`;
    }
    this.slug = baseSlug;
  }

  // Estimate read time (~200 words/min)
  if (this.isModified('content') && this.content) {
    const words = this.content.trim().split(/\s+/).length;
    this.readTime = Math.max(1, Math.ceil(words / 200));
  }

  // Set publishedAt when first published
  if (this.isModified('isPublished') && this.isPublished && !this.publishedAt) {
    this.publishedAt = new Date();
  }

  next();
});

module.exports = mongoose.model('Blog', blogSchema);
