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
       EMERGENCY SAFETY CONTROLS
       All default false — must be explicitly enabled.
    ============================================= */
    bookingsDisabled:  { type: Boolean, default: false },
    paymentsFreezed:   { type: Boolean, default: false },
    payoutsFreezed:    { type: Boolean, default: false },
    emergencyLockdown: { type: Boolean, default: false },

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
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminSetting", adminSettingSchema);
