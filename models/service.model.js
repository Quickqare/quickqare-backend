const mongoose = require("mongoose");

/* =====================================================
   SERVICE SCHEMA (PRODUCTION READY)
===================================================== */
const serviceSchema = new mongoose.Schema(
  {
    /* =====================
       BASIC INFO
    ===================== */
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    description: {
      type: String,
      default: "",
    },

    /* =====================
       URL FRIENDLY SLUG
       (fast search / SEO / caching)
    ===================== */
    slug: {
      type: String,
      lowercase: true,
      trim: true,
      index: true,
    },

    /* =====================
       CATEGORY STRUCTURE
       (NEW PRODUCTION SYSTEM)
    ===================== */

    // Category reference
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: false, // optional for backward compatibility
      index: true,
    },

    // SubCategory reference
    subCategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubCategory",
      required: false,
      index: true,
    },

    /* =====================
       BACKWARD COMPATIBILITY
       (OLD STRING CATEGORY)
    ===================== */
    legacyCategory: {
      type: String,
      lowercase: true,
      index: true,
    },

    /* =====================
       IMAGE (CLOUDINARY URL)
    ===================== */
    imageUrl: {
      type: String,
      default: "",
    },

    /* =====================
       PRICING
    ===================== */
    price: {
      type: Number,
      required: true,
      min: 0,
    },

    commissionPercent: {
      type: Number,
      default: 20,
      min: 0,
      max: 100,
    },

    duration: {
      type: Number, // minutes
      default: 60,
      min: 1,
    },

    /* =====================
       SERVICE METADATA
       (Future ranking / sorting)
    ===================== */
    popularityScore: {
      type: Number,
      default: 0,
    },

    /* =====================
       STATUS
    ===================== */
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

/* =====================
   AUTO GENERATE SLUG
===================== */
serviceSchema.pre("save", function (next) {
  if (!this.isModified("name")) return next();

  this.slug = this.name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, "-");

  next();
});

/* =====================
   INDEXES FOR FAST SEARCH
===================== */
serviceSchema.index({ category: 1, subCategory: 1 });

module.exports = mongoose.model("Service", serviceSchema);
