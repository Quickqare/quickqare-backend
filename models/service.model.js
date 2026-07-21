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

    // Explicit pricing rule for services with non-linear package pricing
    // (mehendi hand tiers). When set, booking pricing uses it directly;
    // when null, the legacy service-NAME matching in utils/pricing.js
    // applies — which silently stops working if the service is renamed.
    // Keep the enum in sync with DEFAULT_MEHENDI_HANDS_PRICING keys.
    pricingRuleKey: {
      type: String,
      enum: [
        null,
        "mehendi_minimal_hands",
        "mehendi_palm_length_hands",
        "mehendi_bangle_length_hands",
        "mehendi_mid_length_hands",
        "mehendi_elbow_bridal_hands",
        "mehendi_above_elbow_bridal_hands",
      ],
      default: null,
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

    // Grace-period override for last-minute advance orders (cakes). An order
    // PLACED with less than appliesBelowLeadHours of notice before its
    // scheduled start lands inside a low/zero refund tier the moment it's
    // booked; this gives the customer windowMinutes from booking creation to
    // cancel for a 100% refund before the normal tiers take over.
    // windowMinutes = 0 disables the grace entirely.
    // appliesBelowLeadHours = 0 (with windowMinutes > 0) applies the grace to
    // every order regardless of notice.
    cancellationGrace: {
      windowMinutes:         { type: Number, default: 0, min: 0 },
      appliesBelowLeadHours: { type: Number, default: 0, min: 0 },
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

      // Every cake can be made with or without egg — this is the customer's
      // per-order choice, distinct from the `isEggless` flag below (which
      // marks a listing as egg-free only, e.g. "Eggless Special Cake").
      egglessPriceDelta: { type: Number, default: 0, min: 0 },

      // Per-section admin toggles — when false the customer can't pick that
      // option for this cake (section hidden client-side, mismatching values
      // rejected server-side). Flavours stay configured even when selection
      // is disabled: the first flavour then applies as the fixed default,
      // and a non-empty flavours list is what marks a service as a cake.
      flavoursEnabled:       { type: Boolean, default: true },
      weightsEnabled:        { type: Boolean, default: true },
      tiersEnabled:          { type: Boolean, default: true },
      addonsEnabled:         { type: Boolean, default: true },
      referencePhotoEnabled: { type: Boolean, default: true },
      egglessOptionEnabled:  { type: Boolean, default: true },
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
    // Shown in the MOBILE APP only (cakes are the exception: their Cake Setup
    // gallery is shared with the web cake customizer).
    media360: {
      type: [String],
      default: [],
    },

    // Separate ordered photo gallery for the WEB service cards — mirrors the
    // imageUrl/webImageUrl split so admins control each platform independently.
    webMedia360: {
      type: [String],
      default: [],
    },

    // When false, the APP gallery (media360) stays on the first photo
    // instead of auto-sliding. Controlled independently from the web toggle
    // below — admins can turn one platform's slideshow off without affecting
    // the other.
    autoSlideEnabled: {
      type: Boolean,
      default: true,
    },

    // Seconds each photo stays before sliding to the next, APP only.
    autoSlideSeconds: {
      type: Number,
      default: 3,
      min: 1,
      max: 30,
    },

    // Same as autoSlideEnabled/autoSlideSeconds above, but for the WEB card
    // carousel (webMedia360) — mirrors the imageUrl/webImageUrl split.
    webAutoSlideEnabled: {
      type: Boolean,
      default: true,
    },

    webAutoSlideSeconds: {
      type: Number,
      default: 3,
      min: 1,
      max: 30,
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

    // LEARNED duration — the nightly learnServiceDurations cron blends the
    // real on-site time (inProgressAt -> completedAt) of completed bookings
    // into this via EWMA. The team packer prefers it over the admin-entered
    // `duration`, but always CLAMPED to +/-40% of `duration` so one bad
    // timestamp can never wreck slot capacity or team sizing. null until the
    // cron has enough samples; falls back to `duration` cleanly.
    learnedDurationMinutes: {
      type: Number,
      default: null,
    },

    learnedDurationSamples: {
      type: Number,
      default: 0,
    },

    // Minimum partner skill tier required to perform this service (AC only).
    // 1 = serviceman (cleaning/filter wash), 2 = technician (gas refill,
    // repair, install/uninstall). Matches Partner.skillTier collected at
    // signup — the assignment engine blocks partners below this tier.
    skillTier: {
      type: Number,
      default: 1,
      min: 1,
      max: 2,
    },

    // How the team-sizing packer treats this service (mehendi only).
    // BRIDAL      = dedicated 2-artist allocation per bride
    // HAND        = guest hand work, pairable with a feet add-on
    // FEET_ADDON  = feet add-on merged onto a hand task (same guest)
    // INDEPENDENT = standalone task (guest mehendi, long leg work)
    // null        = not applicable / fall back to name-based detection.
    packingRole: {
      type: String,
      enum: ["BRIDAL", "HAND", "FEET_ADDON", "INDEPENDENT", null],
      default: null,
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
