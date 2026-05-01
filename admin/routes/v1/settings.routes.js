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
    }

    settings.updatedByAdminId = req.adminUser.id;
    await settings.save();

    return success(res, settings, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "SETTINGS_UPDATE_FAILED", "Unable to update settings", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
