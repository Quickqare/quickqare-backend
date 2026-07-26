const express = require("express");
const AdminSetting = require("../admin/models/AdminSetting");
const ReferralSettings = require("../models/ReferralSettings");

const router = express.Router();

const DEFAULT_SOCIAL_LINKS = {
  whatsapp: "", instagram: "", facebook: "", twitter: "", youtube: "",
};

const DEFAULT_CONTACT_INFO = { email: "", phone: "" };

const ICON_ANIM_STYLES = ["none", "bob", "bounce", "tada"];
// Legacy values (booleans from the earlier on/off version) map to bob/none.
const iconAnimStyle = (v) => {
  if (v === false) return "none";
  return ICON_ANIM_STYLES.includes(v) ? v : "bob";
};

const DEFAULT_THEME = {
  isActive: false,
  themeName: "default",
  primaryColor: "#0A0A0A",
  accentColor: "#FFFFFF",
  backgroundColor: "#F5F5F5",
  promoTagBadge: "LIMITED OFFER",
  promoTagline: "",
  promoCta: "Book now  →",
};

/**
 * GET /api/app-config
 * Public — no auth required.
 * Returns the currently active home-screen theme and pricing config
 * so the customer app can apply festival / campaign colours and
 * show an accurate price breakdown before payment.
 */
router.get("/", async (_req, res) => {
  try {
    const [settings, referralSettings] = await Promise.all([
      AdminSetting.findOne().lean(),
      ReferralSettings.findOne().lean(),
    ]);
    const theme = settings?.homeTheme ?? DEFAULT_THEME;
    const pricingSettings = settings?.pricing ?? {};

    return res.json({
      success: true,
      pricing: {
        taxPercent:          Number(pricingSettings.taxPercent         ?? 18),
        platformFeePercent:  Number(pricingSettings.platformFeePercent ?? 0),
        platformFeeFlatInr:  Number(pricingSettings.platformFeeFlatInr ?? 0),
      },
      referral: {
        isEnabled:             Boolean(referralSettings?.isEnabled ?? true),
        referrerRewardAmount:  Number(referralSettings?.referrerRewardAmount  ?? 50),
        newUserDiscountAmount: Number(referralSettings?.newUserDiscountAmount ?? 100),
      },
      emergency: {
        bookingsDisabled:  Boolean(settings?.bookingsDisabled  ?? false),
        paymentsFreezed:   Boolean(settings?.paymentsFreezed   ?? false),
        emergencyLockdown: Boolean(settings?.emergencyLockdown ?? false),
      },
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
      // Web shows a built-in promo banner when no custom banner is live, unless
      // this is explicitly turned off. Default true (undefined → true).
      defaultBannerEnabled: settings?.defaultBannerEnabled !== false,
      // Customer app + web: home category icon animation (entrance + loop).
      // Off = icons render static. Default true (undefined → true).
      homeIconAnimationEnabled: settings?.homeIconAnimationEnabled !== false,
      // Per-icon animation style ("none" | "bob" | "bounce" | "tada") —
      // only consulted when the master switch above is on.
      homeIconAnimation: {
        acRepair:    iconAnimStyle(settings?.homeIconAnimation?.acRepair),
        plumbing:    iconAnimStyle(settings?.homeIconAnimation?.plumbing),
        mehendi:     iconAnimStyle(settings?.homeIconAnimation?.mehendi),
        electrician: iconAnimStyle(settings?.homeIconAnimation?.electrician),
        celebration: iconAnimStyle(settings?.homeIconAnimation?.celebration),
        offers:      iconAnimStyle(settings?.homeIconAnimation?.offers),
      },
      socialLinks: {
        whatsapp:  settings?.socialLinks?.whatsapp  || DEFAULT_SOCIAL_LINKS.whatsapp,
        instagram: settings?.socialLinks?.instagram || DEFAULT_SOCIAL_LINKS.instagram,
        facebook:  settings?.socialLinks?.facebook  || DEFAULT_SOCIAL_LINKS.facebook,
        twitter:   settings?.socialLinks?.twitter   || DEFAULT_SOCIAL_LINKS.twitter,
        youtube:   settings?.socialLinks?.youtube   || DEFAULT_SOCIAL_LINKS.youtube,
      },
      contactInfo: {
        email: settings?.contactInfo?.email || DEFAULT_CONTACT_INFO.email,
        phone: settings?.contactInfo?.phone || DEFAULT_CONTACT_INFO.phone,
      },
      homeTheme: {
        isActive:        Boolean(theme.isActive),
        targetPlatform:  theme.targetPlatform  || "both",
        themeName:       theme.themeName       || DEFAULT_THEME.themeName,
        primaryColor:    theme.primaryColor    || DEFAULT_THEME.primaryColor,
        accentColor:     theme.accentColor     || DEFAULT_THEME.accentColor,
        backgroundColor: theme.backgroundColor || DEFAULT_THEME.backgroundColor,
        promoTagBadge:   theme.promoTagBadge   || DEFAULT_THEME.promoTagBadge,
        promoTagline:    theme.promoTagline     ?? DEFAULT_THEME.promoTagline,
        promoCta:        theme.promoCta        || DEFAULT_THEME.promoCta,
        promoIconUrl:    theme.promoIconUrl    ?? "",
        categoryIcons: {
          acRepair:           theme.categoryIcons?.acRepair    ?? "",
          acRepairShimmer:    theme.categoryIcons?.acRepairShimmer    !== false,
          plumbing:           theme.categoryIcons?.plumbing    ?? "",
          plumbingShimmer:    theme.categoryIcons?.plumbingShimmer    !== false,
          mehendi:            theme.categoryIcons?.mehendi     ?? "",
          mehendiShimmer:     theme.categoryIcons?.mehendiShimmer     !== false,
          electrician:        theme.categoryIcons?.electrician ?? "",
          electricianShimmer: theme.categoryIcons?.electricianShimmer !== false,
          celebration:        theme.categoryIcons?.celebration ?? "",
          celebrationShimmer: theme.categoryIcons?.celebrationShimmer !== false,
        },
      },
    });
  } catch (err) {
    // On any error, return the default so the app never crashes
    return res.json({
      success: true,
      pricing: { taxPercent: 18, platformFeePercent: 0, platformFeeFlatInr: 0 },
      referral: { isEnabled: true, referrerRewardAmount: 50, newUserDiscountAmount: 100 },
      emergency: { bookingsDisabled: false, paymentsFreezed: false, emergencyLockdown: false },
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
      defaultBannerEnabled: true,
      homeIconAnimationEnabled: true,
      homeIconAnimation: {
        acRepair: "bob", plumbing: "bob", mehendi: "bob",
        electrician: "bob", celebration: "bob", offers: "bob",
      },
      socialLinks: DEFAULT_SOCIAL_LINKS,
      contactInfo: DEFAULT_CONTACT_INFO,
      homeTheme: DEFAULT_THEME,
    });
  }
});

module.exports = router;
