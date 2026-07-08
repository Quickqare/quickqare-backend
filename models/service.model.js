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

    // Separate image for web (16:9 banner ratio); app uses imageUrl (4:3)
    webImageUrl: {
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

    // Cancellation refund tiers — sorted by minHoursBefore descending.
    // If empty, the global default tiers apply.
    // e.g. [{ minHoursBefore: 24, refundPercent: 100 }, { minHoursBefore: 4, refundPercent: 75 }, ...]
    cancellationTiers: {
      type: [
        {
          minHoursBefore: { type: Number, required: true, min: 0 },
          refundPercent:  { type: Number, required: true, min: 0, max: 100 },
        },
      ],
      default: [],
    },

    // BEFORE_SERVICE: refund tiers keyed on hours remaining until the service
    // (cancellationTiers above). SINCE_BOOKING: tiers keyed on hours elapsed
    // since the booking was placed (sinceBookingTiers below) — used for
    // advance-order categories like cakes.
    cancellationPolicyType: {
      type: String,
      enum: ["BEFORE_SERVICE", "SINCE_BOOKING"],
      default: "BEFORE_SERVICE",
    },

    // Ascending by maxHoursAfterBooking; first tier where
    // hoursSinceBooking <= maxHoursAfterBooking wins.
    // e.g. cake: [{ maxHoursAfterBooking: 1, refundPercent: 100 },
    //             { maxHoursAfterBooking: 8760, refundPercent: 50 }]
    sinceBookingTiers: {
      type: [
        {
          maxHoursAfterBooking: { type: Number, required: true, min: 0 },
          refundPercent:        { type: Number, required: true, min: 0, max: 100 },
        },
      ],
      default: [],
    },

    /* =====================
       CUSTOMIZATION (per-order options, e.g. cakes)
       Base price = 1-tier cake with the cheapest flavour delta.
    ===================== */
    customization: {
      // Weight/size tiers (e.g. "0.5 kg", "1 kg", "2 kg"). First entry is the
      // base weight (priceDelta 0 by convention, not enforced). Optional —
      // an empty array means the service has no weight choice.
      weights: {
        type: [
          {
            label:      { type: String, required: true, trim: true },
            priceDelta: { type: Number, default: 0, min: 0 },
          },
        ],
        default: [],
      },
      flavours: {
        type: [
          {
            name:       { type: String, required: true, trim: true },
            priceDelta: { type: Number, default: 0, min: 0 },
          },
        ],
        default: [],
      },
      twoTierPriceDelta: { type: Number, default: 0, min: 0 },
      addons: {
        type: [
          {
            name:  { type: String, required: true, trim: true },
            price: { type: Number, required: true, min: 0 },
          },
        ],
        default: [],
      },
      nameOnCakeEnabled: { type: Boolean, default: true },
    },

    // Ingredients shown to the customer (e.g. cakes).
    ingredients: {
      type: [String],
      default: [],
    },

    // Egg-free badge/filter shown to the customer (cakes).
    isEggless: {
      type: Boolean,
      default: false,
    },

    // Ordered photo gallery shown to the customer (Cloudinary URLs) — kept as
    // "media360" for backward compatibility, no longer a rotation-frame set.
    media360: {
      type: [String],
      default: [],
    },

    // Minimum lead time in calendar days between booking and the scheduled
    // date. 0 = same-day allowed; cakes use 1 (order at least a day ahead).
    minLeadDays: {
      type: Number,
      default: 0,
      min: 0,
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
       WEB "HIGHLIGHTS"
       Admin-curated services shown in the Highlights row on the web home page.
       highlightOrder controls their order (lower = first).
    ===================== */
    isHighlighted: {
      type: Boolean,
      default: false,
      index: true,
    },
    highlightOrder: {
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
