const mongoose = require("mongoose");

/* =====================================================
   ZONE SCHEMA (PRODUCTION READY)
   Used for territory control & partner assignment
===================================================== */
const zoneSchema = new mongoose.Schema(
  {
    /* =====================
       PRIMARY PINCODE
    ===================== */
    pincode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      match: [/^\d{6}$/, "Pincode must be 6 digits"],
      index: true,
    },

    /* =====================
       NEARBY PINCODES
       (same priority assignment)
    ===================== */
    nearbyPincodes: {
      type: [String],
      default: [],
    },

    /* =====================
       EXTENDED PINCODES
       (fallback assignment)
    ===================== */
    extendedPincodes: {
      type: [String],
      default: [],
    },

    /* =====================
       ASSIGNMENT PRIORITY
       Lower value = higher priority
    ===================== */
    priority: {
      type: Number,
      default: 1,
    },

    /* =====================
       STATUS
    ===================== */
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    customerAppEnabled: {
      type: Boolean,
      default: true,
    },

    partnerAppEnabled: {
      type: Boolean,
      default: true,
    },

    /* =====================
       PER-SERVICE ACTIVATION
       Controls which service categories
       are available in this pincode.
    ===================== */
    services: {
      acRepair:    { type: Boolean, default: true },
      plumbing:    { type: Boolean, default: true },
      mehendi:     { type: Boolean, default: true },
      electrician: { type: Boolean, default: true },
    },

    /* =====================
       OPTIONAL METADATA
       (future analytics)
    ===================== */
    city: {
      type: String,
      default: "",
    },

    state: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

/* =====================
   PERFORMANCE INDEXES
===================== */

module.exports = mongoose.model("Zone", zoneSchema);
