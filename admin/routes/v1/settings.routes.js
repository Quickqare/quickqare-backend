const express = require("express");
const AdminSetting = require("../../models/AdminSetting");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { success, fail } = require("../../utils/response");
const { isSafeLinkUrl } = require("../../../utils/safeUrl");

const router = express.Router();

const SOCIAL_LINK_KEYS = ["whatsapp", "instagram", "facebook", "twitter", "youtube"];

router.use(authenticateAdmin, authorize(PERMISSIONS.SETTINGS_MANAGE));

async function getOrCreateSettings() {
  const existing = await AdminSetting.findOne();
  if (existing) return existing;
  return AdminSetting.create({});
}

router.get("/settings", async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    return success(res, settings, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "SETTINGS_FETCH_FAILED", "Unable to fetch settings", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/settings", audit("admin.settings.update"), async (req, res) => {
  try {
    const settings = await getOrCreateSettings();

    if (req.body.partnerSubscriptionRequired !== undefined) {
      settings.partnerSubscriptionRequired = Boolean(req.body.partnerSubscriptionRequired);
    }
    if (req.body.partnerVerificationRequired !== undefined) {
      settings.partnerVerificationRequired = Boolean(req.body.partnerVerificationRequired);
    }
    if (req.body.partnerSelfieRequired !== undefined) {
      settings.partnerSelfieRequired = Boolean(req.body.partnerSelfieRequired);
    }
    if (req.body.jobSelfieVerificationEnabled !== undefined) {
      settings.jobSelfieVerificationEnabled = Boolean(req.body.jobSelfieVerificationEnabled);
    }
    if (req.body.useLiveLocation !== undefined) {
      settings.useLiveLocation = Boolean(req.body.useLiveLocation);
    }
    if (req.body.useH3Zones !== undefined) {
      settings.useH3Zones = Boolean(req.body.useH3Zones);
    }
    if (req.body.defaultBannerEnabled !== undefined) {
      settings.defaultBannerEnabled = Boolean(req.body.defaultBannerEnabled);
    }
    if (req.body.homeIconAnimationEnabled !== undefined) {
      settings.homeIconAnimationEnabled = Boolean(req.body.homeIconAnimationEnabled);
    }

    // Per-icon home icon animation style. Unknown keys/values are ignored;
    // legacy booleans (old on/off version) map to bob/none.
    if (req.body.homeIconAnimation !== undefined && typeof req.body.homeIconAnimation === "object") {
      const iconKeys = ["acRepair", "plumbing", "mehendi", "electrician", "celebration", "offers"];
      const styles = ["none", "bob", "bounce", "tada"];
      for (const k of iconKeys) {
        let v = req.body.homeIconAnimation[k];
        if (v === true) v = "bob";
        if (v === false) v = "none";
        if (styles.includes(v)) settings.homeIconAnimation[k] = v;
      }
    }

    // Pricing (platform fee + tax). Clamped to sane ranges.
    if (req.body.pricing !== undefined && typeof req.body.pricing === "object") {
      const p = req.body.pricing;
      const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
      const clampFlat = (v) => Math.max(0, Number(v) || 0);
      if (p.platformFeePercent !== undefined) settings.pricing.platformFeePercent = clampPct(p.platformFeePercent);
      if (p.platformFeeFlatInr !== undefined) settings.pricing.platformFeeFlatInr = clampFlat(p.platformFeeFlatInr);
      if (p.taxPercent         !== undefined) settings.pricing.taxPercent         = clampPct(p.taxPercent);
    }

    // Cancellation (flat partner penalty for cancelling after arriving). ≥ 0.
    if (req.body.cancellation !== undefined && typeof req.body.cancellation === "object") {
      const c = req.body.cancellation;
      if (c.arrivedCancelPenaltyInr !== undefined) {
        settings.cancellation.arrivedCancelPenaltyInr = Math.max(0, Number(c.arrivedCancelPenaltyInr) || 0);
      }
    }

    // Assignment business knobs. Invalid values are ignored (not clamped to
    // a surprise) — the current setting stays in force.
    if (req.body.assignment !== undefined && typeof req.body.assignment === "object") {
      const a = req.body.assignment;
      if (a.cakeMaxOrdersPerPartnerPerDay !== undefined) {
        const v = Math.floor(Number(a.cakeMaxOrdersPerPartnerPerDay));
        if (Number.isFinite(v) && v >= 1 && v <= 20) {
          settings.assignment = settings.assignment || {};
          settings.assignment.cakeMaxOrdersPerPartnerPerDay = v;
        }
      }
    }

    // Mehendi hand-package pricing. Per rule: tierPrices replaces the whole
    // array (₹, positive integers, max 10 tiers); overflowPerHand ≥ 0. Rules
    // absent from the payload are left untouched.
    if (req.body.mehendiHandsPricing !== undefined && typeof req.body.mehendiHandsPricing === "object") {
      const { MEHENDI_PRICING_RULE_KEYS } = require("../../../utils/pricing");
      const incoming = req.body.mehendiHandsPricing;
      if (!settings.mehendiHandsPricing) settings.mehendiHandsPricing = {};
      for (const key of MEHENDI_PRICING_RULE_KEYS) {
        const rule = incoming[key];
        if (!rule || typeof rule !== "object") continue;
        if (!settings.mehendiHandsPricing[key]) settings.mehendiHandsPricing[key] = {};
        if (Array.isArray(rule.tierPrices)) {
          settings.mehendiHandsPricing[key].tierPrices = rule.tierPrices
            .map((p) => Math.round(Number(p) || 0))
            .filter((p) => p > 0)
            .slice(0, 10);
        }
        if (rule.overflowPerHand !== undefined) {
          const v = Number(rule.overflowPerHand);
          if (Number.isFinite(v) && v >= 0) {
            settings.mehendiHandsPricing[key].overflowPerHand = v;
          }
        }
      }
      settings.markModified("mehendiHandsPricing");
    }

    // Home theme (festival / campaign UI)
    if (req.body.homeTheme !== undefined && typeof req.body.homeTheme === "object") {
      const t = req.body.homeTheme;
      const hex = (v) => (typeof v === "string" && /^#[0-9A-Fa-f]{3,8}$/.test(v.trim()) ? v.trim() : null);
      if (t.isActive !== undefined)        settings.homeTheme.isActive        = Boolean(t.isActive);
      if (hex(t.primaryColor))             settings.homeTheme.primaryColor    = hex(t.primaryColor);
      if (hex(t.accentColor))             settings.homeTheme.accentColor     = hex(t.accentColor);
      if (hex(t.backgroundColor))          settings.homeTheme.backgroundColor = hex(t.backgroundColor);
      if (typeof t.themeName === "string") settings.homeTheme.themeName       = t.themeName.slice(0, 64);
      if (typeof t.promoTagBadge === "string") settings.homeTheme.promoTagBadge = t.promoTagBadge.slice(0, 32);
      if (typeof t.promoTagline === "string")  settings.homeTheme.promoTagline  = t.promoTagline.slice(0, 80);
      if (typeof t.promoCta === "string")      settings.homeTheme.promoCta      = t.promoCta.slice(0, 40);
      if (typeof t.promoIconUrl === "string")  settings.homeTheme.promoIconUrl  = t.promoIconUrl.slice(0, 512);
      if (t.categoryIcons && typeof t.categoryIcons === "object") {
        const ci = t.categoryIcons;
        const cur = settings.homeTheme.categoryIcons || {};
        settings.homeTheme.categoryIcons = {
          acRepair:           typeof ci.acRepair    === "string" ? ci.acRepair.slice(0, 512)    : (cur.acRepair    || ""),
          acRepairShimmer:    ci.acRepairShimmer    !== undefined ? Boolean(ci.acRepairShimmer)    : (cur.acRepairShimmer    !== false),
          plumbing:           typeof ci.plumbing    === "string" ? ci.plumbing.slice(0, 512)    : (cur.plumbing    || ""),
          plumbingShimmer:    ci.plumbingShimmer    !== undefined ? Boolean(ci.plumbingShimmer)    : (cur.plumbingShimmer    !== false),
          mehendi:            typeof ci.mehendi     === "string" ? ci.mehendi.slice(0, 512)     : (cur.mehendi     || ""),
          mehendiShimmer:     ci.mehendiShimmer     !== undefined ? Boolean(ci.mehendiShimmer)     : (cur.mehendiShimmer     !== false),
          electrician:        typeof ci.electrician === "string" ? ci.electrician.slice(0, 512) : (cur.electrician || ""),
          electricianShimmer: ci.electricianShimmer !== undefined ? Boolean(ci.electricianShimmer) : (cur.electricianShimmer !== false),
          celebration:        typeof ci.celebration === "string" ? ci.celebration.slice(0, 512) : (cur.celebration || ""),
          celebrationShimmer: ci.celebrationShimmer !== undefined ? Boolean(ci.celebrationShimmer) : (cur.celebrationShimmer !== false),
        };
        settings.markModified("homeTheme.categoryIcons");
      }
    }

    // Social media links (footer icons). Each is optional — an empty string
    // hides that icon on the client rather than showing a dead link.
    if (req.body.socialLinks !== undefined && typeof req.body.socialLinks === "object") {
      const s = req.body.socialLinks;
      const url = (v) => (typeof v === "string" ? v.trim().slice(0, 512) : "");

      // These render straight into an <a href> in the web footer, so a
      // `javascript:` URL here would be stored XSS. See utils/safeUrl.js.
      const badLink = SOCIAL_LINK_KEYS.find(
        (key) => s[key] !== undefined && !isSafeLinkUrl(url(s[key]))
      );
      if (badLink) {
        return fail(
          res,
          400,
          "VALIDATION_ERROR",
          `socialLinks.${badLink} must be an absolute http:// or https:// URL`,
          null,
          { requestId: req.requestId }
        );
      }

      const cur = settings.socialLinks || {};
      settings.socialLinks = {
        whatsapp:  s.whatsapp  !== undefined ? url(s.whatsapp)  : (cur.whatsapp  || ""),
        instagram: s.instagram !== undefined ? url(s.instagram) : (cur.instagram || ""),
        facebook:  s.facebook  !== undefined ? url(s.facebook)  : (cur.facebook  || ""),
        twitter:   s.twitter   !== undefined ? url(s.twitter)   : (cur.twitter   || ""),
        youtube:   s.youtube   !== undefined ? url(s.youtube)   : (cur.youtube   || ""),
      };
      settings.markModified("socialLinks");
    }

    settings.updatedByAdminId = req.adminUser.id;
    await settings.save();

    // Broadcast theme change to all connected customer app sockets in real-time
    if (req.body.homeTheme !== undefined && global.io) {
      const t = settings.homeTheme;
      global.io.emit("theme_updated", {
        isActive:        Boolean(t.isActive),
        themeName:       t.themeName,
        primaryColor:    t.primaryColor,
        accentColor:     t.accentColor,
        backgroundColor: t.backgroundColor,
        promoTagBadge:   t.promoTagBadge,
        promoTagline:    t.promoTagline  ?? "",
        promoCta:        t.promoCta,
        promoIconUrl:    t.promoIconUrl  ?? "",
        categoryIcons: {
          acRepair:           t.categoryIcons?.acRepair    ?? "",
          acRepairShimmer:    t.categoryIcons?.acRepairShimmer    !== false,
          plumbing:           t.categoryIcons?.plumbing    ?? "",
          plumbingShimmer:    t.categoryIcons?.plumbingShimmer    !== false,
          mehendi:            t.categoryIcons?.mehendi     ?? "",
          mehendiShimmer:     t.categoryIcons?.mehendiShimmer     !== false,
          electrician:        t.categoryIcons?.electrician ?? "",
          electricianShimmer: t.categoryIcons?.electricianShimmer !== false,
          celebration:        t.categoryIcons?.celebration ?? "",
          celebrationShimmer: t.categoryIcons?.celebrationShimmer !== false,
        },
      });
    }

    return success(res, settings, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "SETTINGS_UPDATE_FAILED", "Unable to update settings", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/emergency", audit("admin.emergency.update"), async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    const allowed = ["bookingsDisabled", "paymentsFreezed", "payoutsFreezed", "emergencyLockdown"];
    for (const key of allowed) {
      if (req.body[key] !== undefined) settings[key] = Boolean(req.body[key]);
    }
    settings.updatedByAdminId = req.adminUser.id;
    await settings.save();
    return success(res, settings, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "EMERGENCY_UPDATE_FAILED", "Unable to update emergency controls", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
