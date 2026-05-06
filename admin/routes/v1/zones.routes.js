const express = require("express");
const mongoose = require("mongoose");
const Zone = require("../../../models/zone.model");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { asSingleString, getPagination } = require("../../utils/common");
const { success, fail } = require("../../utils/response");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.ZONES_MANAGE));

router.get("/", async (req, res) => {
  try {
    const { page, pageSize, skip, limit } = getPagination(req);
    const [rows, total] = await Promise.all([
      Zone.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Zone.countDocuments(),
    ]);
    return success(res, rows, { requestId: req.requestId, pagination: { page, pageSize, total } });
  } catch (error) {
    return fail(res, 500, "ZONES_LIST_FAILED", "Unable to fetch zones", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post("/", audit("admin.zones.create"), async (req, res) => {
  try {
    const pincode = String(req.body.pincode || "").trim();
    if (!pincode) {
      return fail(res, 400, "VALIDATION_ERROR", "pincode is required", null, { requestId: req.requestId });
    }

    const existing = await Zone.findOne({ pincode });
    if (existing) {
      return fail(res, 400, "DUPLICATE", "Zone already exists for this pincode", null, { requestId: req.requestId });
    }

    const s = req.body.services || {};
    const row = await Zone.create({
      pincode,
      nearbyPincodes: Array.isArray(req.body.nearbyPincodes) ? req.body.nearbyPincodes : [],
      extendedPincodes: Array.isArray(req.body.extendedPincodes) ? req.body.extendedPincodes : [],
      isActive: req.body.isActive !== undefined ? Boolean(req.body.isActive) : true,
      customerAppEnabled:
        req.body.customerAppEnabled !== undefined ? Boolean(req.body.customerAppEnabled) : true,
      partnerAppEnabled:
        req.body.partnerAppEnabled !== undefined ? Boolean(req.body.partnerAppEnabled) : true,
      city: String(req.body.city || ""),
      state: String(req.body.state || ""),
      services: {
        acRepair:    s.acRepair    !== undefined ? Boolean(s.acRepair)    : true,
        plumbing:    s.plumbing    !== undefined ? Boolean(s.plumbing)    : true,
        mehendi:     s.mehendi     !== undefined ? Boolean(s.mehendi)     : true,
        electrician: s.electrician !== undefined ? Boolean(s.electrician) : true,
      },
    });

    return success(res, row, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "ZONE_CREATE_FAILED", "Unable to create zone", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/:id", audit("admin.zones.update"), async (req, res) => {
  try {
    const zoneId = asSingleString(req.params.id);
    if (!zoneId || !mongoose.Types.ObjectId.isValid(zoneId)) {
      return fail(res, 400, "INVALID_ID", "Invalid zone id", null, { requestId: req.requestId });
    }

    const patch = {};
    if (req.body.pincode !== undefined) patch.pincode = String(req.body.pincode || "").trim();
    if (req.body.nearbyPincodes !== undefined) patch.nearbyPincodes = req.body.nearbyPincodes || [];
    if (req.body.extendedPincodes !== undefined) patch.extendedPincodes = req.body.extendedPincodes || [];
    if (req.body.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);
    if (req.body.customerAppEnabled !== undefined)
      patch.customerAppEnabled = Boolean(req.body.customerAppEnabled);
    if (req.body.partnerAppEnabled !== undefined)
      patch.partnerAppEnabled = Boolean(req.body.partnerAppEnabled);
    if (req.body.city !== undefined) patch.city = String(req.body.city || "");
    if (req.body.state !== undefined) patch.state = String(req.body.state || "");
    if (req.body.services && typeof req.body.services === "object") {
      const s = req.body.services;
      if (s.acRepair    !== undefined) patch["services.acRepair"]    = Boolean(s.acRepair);
      if (s.plumbing    !== undefined) patch["services.plumbing"]    = Boolean(s.plumbing);
      if (s.mehendi     !== undefined) patch["services.mehendi"]     = Boolean(s.mehendi);
      if (s.electrician !== undefined) patch["services.electrician"] = Boolean(s.electrician);
    }

    const row = await Zone.findByIdAndUpdate(zoneId, { $set: patch }, { new: true }).lean();
    if (!row) {
      return fail(res, 404, "NOT_FOUND", "Zone not found", null, { requestId: req.requestId });
    }

    return success(res, row, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "ZONE_UPDATE_FAILED", "Unable to update zone", error.message, {
      requestId: req.requestId,
    });
  }
});

router.delete("/:id", audit("admin.zones.delete"), async (req, res) => {
  try {
    const zoneId = asSingleString(req.params.id);
    if (!zoneId || !mongoose.Types.ObjectId.isValid(zoneId)) {
      return fail(res, 400, "INVALID_ID", "Invalid zone id", null, { requestId: req.requestId });
    }

    const row = await Zone.findByIdAndDelete(zoneId).lean();
    if (!row) {
      return fail(res, 404, "NOT_FOUND", "Zone not found", null, { requestId: req.requestId });
    }

    return success(res, { deleted: true }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "ZONE_DELETE_FAILED", "Unable to delete zone", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
