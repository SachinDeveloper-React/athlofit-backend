// src/models/Product.model.js
const mongoose = require('mongoose');

// Allowed preset sizes and colours. Colour also accepts any custom string.
const VARIANT_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const VARIANT_COLORS = ['black', 'white', 'red', 'green', 'yellow'];

const reviewSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, trim: true },
  },
  { timestamps: true }
);

// A purchasable variant — a size/colour combination with its own stock.
const variantSchema = new mongoose.Schema(
  {
    size: { type: String, trim: true, default: '' },   // 'S'|'M'|'L'|'XL'|'XXL' or ''
    color: { type: String, trim: true, default: '' },  // preset or custom colour name, or ''
    stock: { type: Number, default: 0, min: 0 },
    sku: { type: String, trim: true, default: '' },
    // Optional per-variant price override (₹). null = use product price.
    priceOverride: { type: Number, min: 0, default: null },
  },
  { _id: true }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    discountedPrice: { type: Number, min: 0, default: null },
    images: [{ type: String }],
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    stock: { type: Number, default: 0, min: 0 }, // used when product has no variants
    tags: [{ type: String, trim: true }],
    isFeatured: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    rating: { type: Number, default: 0, min: 0, max: 5 },
    reviewCount: { type: Number, default: 0 },
    reviews: [reviewSchema],
    coinReward: { type: Number, default: 0 }, // coins earned when purchasing

    // ─── Variants (size / colour with per-variant stock) ────────────────────
    hasVariants: { type: Boolean, default: false },
    variants: { type: [variantSchema], default: [] },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Virtual: total stock = variant stock sum when variants exist, else base stock.
productSchema.virtual('totalStock').get(function () {
  if (this.hasVariants && this.variants?.length) {
    return this.variants.reduce((sum, v) => sum + (v.stock || 0), 0);
  }
  return this.stock;
});

// Keep hasVariants in sync and mirror total stock into `stock` for list views.
productSchema.pre('save', function (next) {
  this.hasVariants = Array.isArray(this.variants) && this.variants.length > 0;
  if (this.hasVariants) {
    this.stock = this.variants.reduce((sum, v) => sum + (v.stock || 0), 0);
  }
  next();
});

// Update avg rating on review add
productSchema.methods.updateRating = function () {
  if (this.reviews.length === 0) {
    this.rating = 0;
    this.reviewCount = 0;
    return;
  }
  const sum = this.reviews.reduce((acc, r) => acc + r.rating, 0);
  this.rating = Math.round((sum / this.reviews.length) * 10) / 10;
  this.reviewCount = this.reviews.length;
};

module.exports = mongoose.model('Product', productSchema);
module.exports.VARIANT_SIZES = VARIANT_SIZES;
module.exports.VARIANT_COLORS = VARIANT_COLORS;

