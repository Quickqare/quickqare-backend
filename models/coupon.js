const mongoose = require("mongoose");

/* =====================================================
   COUPON SCHEMA (PRODUCTION READY)
===================================================== */
const couponSchema = new mongoose.Schema(
  {
    /* =====================
       BASIC INFO
    ===================== */
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },

    /* =====================
       DISCOUNT TYPE
    ===================== */
    discountType: {
      type: String,
      enum: ["flat", "percent"],
      required: true,
    },

    discountValue: {
      type: Number,
      required: true,
    },

    /* =====================
       LIMITS
    ===================== */

    // minimum booking amount required
    minAmount: {
      type: Number,
      default: 0,
    },

    // max discount allowed (important for % coupons)
    maxDiscount: {
      type: Number,
      default: null,
    },

    /* =====================
       USAGE CONTROL
    ===================== */

    // total usage limit
    usageLimit: {
      type: Number,
      default: null,
    },

    // how many times used
    usedCount: {
      type: Number,
      default: 0,
    },

    // per user usage limit
    perUserLimit: {
      type: Number,
      default: 1,
    },

    /* =====================
       APPLICABLE SERVICES (OPTIONAL)
       Example: only beauty category
    ===================== */
    applicableCategories: [
      {
        type: String,
      },
    ],

    /* =====================
       EXPIRY
    ===================== */
    expiresAt: {
      type: Date,
      required: true,
    },

    /* =====================
       STATUS
    ===================== */
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Coupon", couponSchema);
