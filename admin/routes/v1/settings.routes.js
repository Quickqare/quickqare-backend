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
