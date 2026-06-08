const express = require("express");
const mongoose = require("mongoose");
const Hub = require("../../../models/Hub");
const Partner = require("../../../models/Partner");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { getPagination } = require("../../utils/common");
const { success, fail } = require("../../utils/response");
const { isValidCell, cellsCentroid } = require("../../../utils/h3");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.ZONES_MANAGE));

/* Clean + dedupe a list of H3 cell indices. */
function cleanCells(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((v) => String(v || "").trim())
        .filter((v) => isValidCell(v))
    ),
  ];
}

/* Returns any cells already claimed by another hub. Each cell must
   belong to exactly one hub, or booking → hub resolution is ambiguous. */
async function findCellConflicts(cells, excludeHubId) {
  if (!cells.length) return [];
  const query = { h3Cells: { $in: cells } };
  if (excludeHubId) query._id = { $ne: excludeHubId };

  const hubs = await Hub.find(query).select("h3Cells").lean();
  const wanted = new Set(cells);
  const conflicts = new Set();
  for (const hub of hubs) {
    for (const c of hub.h3Cells || []) {
      if (wanted.has(c)) conflicts.add(c);
    }
  }
  return [...conflicts];
}

/* ── List ─────────────────────────────────────────────────────────────────── */
router.get("/", async (req, res) => {
  try {
    const { page, pageSize, skip, limit } = getPagination(req);
    const [hubs, total] = await Promise.all([
      Hub.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Hub.countDocuments(),
    ]);

    // Attach partner counts per hub
    const hubIds = hubs.map((h) => h._id);
    const counts = await Partner.aggregate([
      { $match: { assignedHubId: { $in: hubIds } } },
      { $group: { _id: "$assignedHubId", count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

    const withCounts = hubs.map((h) => ({
      ...h,
      partnerCount: countMap.get(String(h._id)) || 0,
    }));

    return success(res, { hubs: withCounts }, {
      requestId: req.requestId,
      pagination: { page, pageSize, total },
    });
  } catch (err) {
    return fail(res, 500, "HUBS_LIST_FAILED", "Unable to fetch hubs", err.message, { requestId: req.requestId });
  }
});

/* ── Create ───────────────────────────────────────────────────────────────── */
router.post("/", audit("admin.hubs.create"), async (req, res) => {
  try {
    const { name, h3Cells, city, state, isActive, customerAppEnabled, partnerAppEnabled, services, center } = req.body;

    if (!name || !String(name).trim()) {
      return fail(res, 400, "VALIDATION_ERROR", "Hub name is required", null, { requestId: req.requestId });
    }

    const cells = cleanCells(h3Cells);
    if (!cells.length) {
      return fail(res, 400, "VALIDATION_ERROR", "Select at least one cell on the map to define the hub", null, { requestId: req.requestId });
    }

    const conflicts = await findCellConflicts(cells, null);
    if (conflicts.length) {
      return fail(res, 409, "CELL_CONFLICT", `${conflicts.length} cell(s) already belong to another hub. Each cell can be in only one hub.`, null, { requestId: req.requestId });
    }

    const s = services || {};
    const centroid = (center && Number.isFinite(center.lat) && Number.isFinite(center.lng))
      ? { lat: center.lat, lng: center.lng }
      : cellsCentroid(cells) || { lat: null, lng: null };

    const hub = await Hub.create({
      name: String(name).trim(),
      h3Cells: cells,
      resolution: 7,
      center: centroid,
      city: String(city || ""),
      state: String(state || ""),
      isActive: isActive !== undefined ? Boolean(isActive) : true,
      customerAppEnabled: customerAppEnabled !== undefined ? Boolean(customerAppEnabled) : true,
      partnerAppEnabled: partnerAppEnabled !== undefined ? Boolean(partnerAppEnabled) : true,
      services: {
        acRepair:    s.acRepair    !== undefined ? Boolean(s.acRepair)    : true,
        plumbing:    s.plumbing    !== undefined ? Boolean(s.plumbing)    : true,
        mehendi:     s.mehendi     !== undefined ? Boolean(s.mehendi)     : true,
        electrician: s.electrician !== undefined ? Boolean(s.electrician) : true,
      },
    });

    return success(res, hub, { requestId: req.requestId });
  } catch (err) {
    return fail(res, 500, "HUB_CREATE_FAILED", "Unable to create hub", err.message, { requestId: req.requestId });
  }
});

/* ── Update ───────────────────────────────────────────────────────────────── */
router.patch("/:id", audit("admin.hubs.update"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, "INVALID_ID", "Invalid hub id", null, { requestId: req.requestId });
    }

    const patch = {};
    const { name, h3Cells, city, state, isActive, customerAppEnabled, partnerAppEnabled, services, center } = req.body;

    if (name !== undefined) {
      if (!String(name).trim()) {
        return fail(res, 400, "VALIDATION_ERROR", "Hub name cannot be empty", null, { requestId: req.requestId });
      }
      patch.name = String(name).trim();
    }

    if (h3Cells !== undefined) {
      const cells = cleanCells(h3Cells);
      if (!cells.length) {
        return fail(res, 400, "VALIDATION_ERROR", "A hub must have at least one cell", null, { requestId: req.requestId });
      }
      const conflicts = await findCellConflicts(cells, id);
      if (conflicts.length) {
        return fail(res, 409, "CELL_CONFLICT", `${conflicts.length} cell(s) already belong to another hub.`, null, { requestId: req.requestId });
      }
      patch.h3Cells = cells;
      // Recompute centroid unless explicitly provided
      if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
        patch.center = { lat: center.lat, lng: center.lng };
      } else {
        patch.center = cellsCentroid(cells) || { lat: null, lng: null };
      }
    } else if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
      patch.center = { lat: center.lat, lng: center.lng };
    }

    if (city  !== undefined) patch.city  = String(city);
    if (state !== undefined) patch.state = String(state);
    if (isActive !== undefined) patch.isActive = Boolean(isActive);
    if (customerAppEnabled !== undefined) patch.customerAppEnabled = Boolean(customerAppEnabled);
    if (partnerAppEnabled  !== undefined) patch.partnerAppEnabled  = Boolean(partnerAppEnabled);

    if (services && typeof services === "object") {
      const s = services;
      if (s.acRepair    !== undefined) patch["services.acRepair"]    = Boolean(s.acRepair);
      if (s.plumbing    !== undefined) patch["services.plumbing"]    = Boolean(s.plumbing);
      if (s.mehendi     !== undefined) patch["services.mehendi"]     = Boolean(s.mehendi);
      if (s.electrician !== undefined) patch["services.electrician"] = Boolean(s.electrician);
    }

    const hub = await Hub.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
    if (!hub) {
      return fail(res, 404, "NOT_FOUND", "Hub not found", null, { requestId: req.requestId });
    }

    return success(res, hub, { requestId: req.requestId });
  } catch (err) {
    return fail(res, 500, "HUB_UPDATE_FAILED", "Unable to update hub", err.message, { requestId: req.requestId });
  }
});

/* ── Delete ───────────────────────────────────────────────────────────────── */
router.delete("/:id", audit("admin.hubs.delete"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, "INVALID_ID", "Invalid hub id", null, { requestId: req.requestId });
    }

    // Unassign any partners pointing at this hub so they don't dangle.
    await Partner.updateMany({ assignedHubId: id }, { $set: { assignedHubId: null } });

    const hub = await Hub.findByIdAndDelete(id).lean();
    if (!hub) {
      return fail(res, 404, "NOT_FOUND", "Hub not found", null, { requestId: req.requestId });
    }

    return success(res, { deleted: true }, { requestId: req.requestId });
  } catch (err) {
    return fail(res, 500, "HUB_DELETE_FAILED", "Unable to delete hub", err.message, { requestId: req.requestId });
  }
});

module.exports = router;
