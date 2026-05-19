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

/* Clean + dedupe a list of 6-digit pincodes. */
function cleanPincodes(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((v) => String(v || "").trim())
        .filter((v) => /^\d{6}$/.test(v))
    ),
  ];
}

/* Returns any pincodes that already belong to another zone (as primary,
   nearby, or extended). Each pincode must live in exactly one zone, or
   resolveZoneForPincode becomes ambiguous. */
async function findPincodeConflicts(pincodes, excludeZoneId) {
  if (!pincodes.length) return [];
  const query = {
    $or: [
      { pincode: { $in: pincodes } },
      { nearbyPincodes: { $in: pincodes } },
      { extendedPincodes: { $in: pincodes } },
    ],
  };
  if (excludeZoneId) query._id = { $ne: excludeZoneId };

  const zones = await Zone.find(query)
    .select("pincode nearbyPincodes extendedPincodes")
    .lean();

  const wanted = new Set(pincodes);
  const conflicts = new Set();
  for (const zone of zones) {
    for (const p of [
      zone.pincode,
      ...(zone.nearbyPincodes || []),
      ...(zone.extendedPincodes || []),
    ]) {
      if (wanted.has(p)) conflicts.add(p);
    }
  }
  return [...conflicts];
}

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
    if (!/^\d{6}$/.test(pincode)) {
      return fail(res, 400, "VALIDATION_ERROR", "A valid 6-digit primary pincode is required", null, { requestId: req.requestId });
    }

    // Normalise the rest of the zone's pincodes and drop the primary if echoed.
    const nearbyPincodes = cleanPincodes(req.body.nearbyPincodes).filter((p) => p !== pincode);
    const extendedPincodes = cleanPincodes(req.body.extendedPincodes).filter(
      (p) => p !== pincode && !nearbyPincodes.includes(p)
    );

    const allPincodes = [pincode, ...nearbyPincodes, ...extendedPincodes];
    const conflicts = await findPincodeConflicts(allPincodes, null);
    if (conflicts.length) {
      return fail(
        res,
        400,
        "PINCODE_CONFLICT",
        `These pincodes already belong to another zone: ${conflicts.join(", ")}. Each pincode can be in only one zone.`,
        null,
        { requestId: req.requestId }
      );
    }

    const s = req.body.services || {};
    const row = await Zone.create({
      pincode,
      nearbyPincodes,
      extendedPincodes,
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

    const pincodeFieldsTouched =
      req.body.pincode !== undefined ||
      req.body.nearbyPincodes !== undefined ||
      req.body.extendedPincodes !== undefined;

    let existingZone = null;
    if (pincodeFieldsTouched) {
      existingZone = await Zone.findById(zoneId).lean();
      if (!existingZone) {
        return fail(res, 404, "NOT_FOUND", "Zone not found", null, { requestId: req.requestId });
      }
    }

    const patch = {};

    if (pincodeFieldsTouched) {
      const primary =
        req.body.pincode !== undefined
          ? String(req.body.pincode || "").trim()
          : existingZone.pincode;
      if (!/^\d{6}$/.test(primary)) {
        return fail(res, 400, "VALIDATION_ERROR", "A valid 6-digit primary pincode is required", null, { requestId: req.requestId });
      }
      const nearby = cleanPincodes(
        req.body.nearbyPincodes !== undefined ? req.body.nearbyPincodes : existingZone.nearbyPincodes
      ).filter((p) => p !== primary);
      const extended = cleanPincodes(
        req.body.extendedPincodes !== undefined ? req.body.extendedPincodes : existingZone.extendedPincodes
      ).filter((p) => p !== primary && !nearby.includes(p));

      const conflicts = await findPincodeConflicts([primary, ...nearby, ...extended], zoneId);
      if (conflicts.length) {
        return fail(
          res,
          400,
          "PINCODE_CONFLICT",
          `These pincodes already belong to another zone: ${conflicts.join(", ")}. Each pincode can be in only one zone.`,
          null,
          { requestId: req.requestId }
        );
      }

      patch.pincode = primary;
      patch.nearbyPincodes = nearby;
      patch.extendedPincodes = extended;
    }

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
