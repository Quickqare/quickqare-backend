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
       HOME SCREEN THEME  (festival / campaign UI)
       All color values are CSS hex strings.
       isActive = false  →  app uses its default
                             monochrome theme.
    ============================================= */
    homeTheme: {
      isActive:         { type: Boolean, default: false },
      themeName:        { type: String,  default: "default" },
      primaryColor:     { type: String,  default: "#0A0A0A" },
      accentColor:      { type: String,  default: "#FFFFFF" },
      backgroundColor:  { type: String,  default: "#F5F5F5" },
      // Optional: shown in the promo fallback banner when no banners are live
      promoTagBadge:    { type: String,  default: "LIMITED OFFER" },
      promoTagline:     { type: String,  default: "" },
      promoCta:         { type: String,  default: "Book now  →" },
      promoIconUrl:     { type: String,  default: "" },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminSetting", adminSettingSchema);
