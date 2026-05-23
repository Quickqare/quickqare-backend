const express = require("express");
const AdminSetting = require("../../models/AdminSetting");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { success, fail } = require("../../utils/response");

const router = express.Router();

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
    if (req.body.useLiveLocation !== undefined) {
      settings.useLiveLocation = Boolean(req.body.useLiveLocation);
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
        };
        settings.markModified("homeTheme.categoryIcons");
      }
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
