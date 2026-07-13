const mongoose = require("mongoose");

const adminSettingSchema = new mongoose.Schema(
  {
    partnerSubscriptionRequired: {
      type: Boolean,
      default: false,
    },
    partnerVerificationRequired: {
      type: Boolean,
      default: false,
    },
    partnerSelfieRequired: {
      type: Boolean,
      default: false,
    },
    /* Job-spot selfie verification: partner must upload a live selfie at the
       customer's location before the service can start. The customer app also
       shows the partner's onboarding photo so the customer can match the face.
       Distinct from partnerSelfieRequired (signup selfie). */
    jobSelfieVerificationEnabled: {
      type: Boolean,
      default: false,
    },
    updatedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      default: null,
    },

    /* =============================================
       LIVE LOCATION & ASSIGNMENT
    ============================================= */
    useLiveLocation: { type: Boolean, default: false },

    /* =============================================
       H3 GEOSPATIAL ASSIGNMENT
       false (default) = pincode-based assignment (current behaviour)
       true            = H3-based assignment (flip when ready)
    ============================================= */
    useH3Zones: { type: Boolean, default: false },

    /* =============================================
       PRICING (platform fee + tax)
       Shown to the customer as a single combined
       "Fees and Taxes" line. Backend remains
       the source of truth for money.
    ============================================= */
    pricing: {
      platformFeePercent: { type: Number, default: 0 },   // % of taxable amount
      platformFeeFlatInr: { type: Number, default: 0 },   // flat ₹ added per booking
      taxPercent:         { type: Number, default: 18 },  // % of (taxable + platform fee)
    },

    /* =============================================
       CANCELLATION
       Flat ₹ penalty charged to a partner who cancels
       AFTER arriving at the customer's location (the
       trip was wasted by the partner walking away).
    ============================================= */
    cancellation: {
      arrivedCancelPenaltyInr: { type: Number, default: 100 },
    },

    /* =============================================
       EMERGENCY SAFETY CONTROLS
       All default false — must be explicitly enabled.
    ============================================= */
    bookingsDisabled:  { type: Boolean, default: false },
    paymentsFreezed:   { type: Boolean, default: false },
    payoutsFreezed:    { type: Boolean, default: false },
    emergencyLockdown: { type: Boolean, default: false },

    /* =============================================
       WEB DEFAULT PROMO BANNER
       When true (default), the web home page shows a
       built-in promo banner whenever no custom banner
       is active. Admin can switch it off.
    ============================================= */
    defaultBannerEnabled: { type: Boolean, default: true },

    /* =============================================
       APP HOME ICON ANIMATION
       When true (default), the customer app's category
       quick-access icons play a staggered slide-up
       entrance on the home screen. Off = icons render
       static with no motion.
    ============================================= */
    homeIconAnimationEnabled: { type: Boolean, default: true },

    /* Per-icon animation style for the home category icons (app + web).
       Only consulted when homeIconAnimationEnabled (the master switch) is
       true. "none" = that icon stays static even with the master on.
       "offers" is the app-only Offers icon at the end of the quick-row. */
    homeIconAnimation: {
      acRepair:    { type: String, enum: ["none", "bob", "bounce", "tada"], default: "bob" },
      plumbing:    { type: String, enum: ["none", "bob", "bounce", "tada"], default: "bob" },
      mehendi:     { type: String, enum: ["none", "bob", "bounce", "tada"], default: "bob" },
      electrician: { type: String, enum: ["none", "bob", "bounce", "tada"], default: "bob" },
      celebration: { type: String, enum: ["none", "bob", "bounce", "tada"], default: "bob" },
      offers:      { type: String, enum: ["none", "bob", "bounce", "tada"], default: "bob" },
    },

    /* =============================================
       HOME SCREEN THEME  (festival / campaign UI)
       All color values are CSS hex strings.
       isActive = false  →  app uses its default
                             monochrome theme.
    ============================================= */
    homeTheme: {
      isActive:         { type: Boolean, default: false },
      // "both" = app + web, "app" = mobile only, "web" = web only
      targetPlatform:   { type: String, enum: ["both", "app", "web"], default: "both" },
      themeName:        { type: String,  default: "default" },
      primaryColor:     { type: String,  default: "#0A0A0A" },
      accentColor:      { type: String,  default: "#FFFFFF" },
      backgroundColor:  { type: String,  default: "#F5F5F5" },
      // Optional: shown in the promo fallback banner when no banners are live
      promoTagBadge:    { type: String,  default: "LIMITED OFFER" },
      promoTagline:     { type: String,  default: "" },
      promoCta:         { type: String,  default: "Book now  →" },
      promoIconUrl:     { type: String,  default: "" },
      categoryIcons: {
        acRepair:           { type: String,  default: "" },
        acRepairShimmer:    { type: Boolean, default: true },
        plumbing:           { type: String,  default: "" },
        plumbingShimmer:    { type: Boolean, default: true },
        mehendi:            { type: String,  default: "" },
        mehendiShimmer:     { type: Boolean, default: true },
        electrician:        { type: String,  default: "" },
        electricianShimmer: { type: Boolean, default: true },
        celebration:        { type: String,  default: "" },
        celebrationShimmer: { type: Boolean, default: true },
      },
    },

    /* =============================================
       SOCIAL MEDIA LINKS
       Shown as icons in the web/app footer. Empty
       string = not shown for that platform.
    ============================================= */
    socialLinks: {
      whatsapp:  { type: String, default: "" },
      instagram: { type: String, default: "" },
      facebook:  { type: String, default: "" },
      twitter:   { type: String, default: "" }, // X (formerly Twitter)
      youtube:   { type: String, default: "" },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminSetting", adminSettingSchema);
