const express = require("express");
const mongoose = require("mongoose");
const Hub = require("../../../models/Hub");
const Partner = require("../../../models/Partner");
const Category = require("../../../models/Category");
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

/* Returns any cells already claimed by another hub *of the same category*.
   Within one category each cell must belong to exactly one hub (or booking →
   hub resolution is ambiguous). Hubs of different categories may overlap, so
   conflicts are scoped to categoryId. */
async function findCellConflicts(cells, categoryId, excludeHubId) {
  if (!cells.length || !categoryId) return [];
  const query = { h3Cells: { $in: cells }, category: categoryId };
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

/* Validate a category id and return the live Category doc, or null. */
async function resolveCategory(categoryId) {
  if (!mongoose.Types.ObjectId.isValid(categoryId)) return null;
  return Category.findById(categoryId).lean();
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

/* ── Categories (for the hub service picker) ──────────────────────────────── */
router.get("/categories", async (req, res) => {
  try {
    const rows = await Category.find({ isActive: { $ne: false } })
      .sort({ name: 1 })
      .select("name slug imageUrl isActive")
      .lean();
    return success(res, rows, { requestId: req.requestId });
  } catch (err) {
    return fail(res, 500, "CATEGORIES_LIST_FAILED", "Unable to fetch categories", err.message, { requestId: req.requestId });
  }
});

/* ── Create ───────────────────────────────────────────────────────────────── */
router.post("/", audit("admin.hubs.create"), async (req, res) => {
  try {
    const { name, h3Cells, city, state, isActive, customerAppEnabled, partnerAppEnabled, categoryId, center } = req.body;

    if (!name || !String(name).trim()) {
      return fail(res, 400, "VALIDATION_ERROR", "Hub name is required", null, { requestId: req.requestId });
    }

    const category = await resolveCategory(categoryId);
    if (!category) {
      return fail(res, 400, "VALIDATION_ERROR", "Select a valid service category for this hub", null, { requestId: req.requestId });
    }

    const cells = cleanCells(h3Cells);
    if (!cells.length) {
      return fail(res, 400, "VALIDATION_ERROR", "Select at least one cell on the map to define the hub", null, { requestId: req.requestId });
    }

    const conflicts = await findCellConflicts(cells, category._id, null);
    if (conflicts.length) {
      return fail(res, 409, "CELL_CONFLICT", `${conflicts.length} cell(s) already belong to another ${category.name} hub. Within one service, each cell can be in only one hub.`, null, { requestId: req.requestId });
    }

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
      category: category._id,
      categoryName: category.name,
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

    const existing = await Hub.findById(id).select("h3Cells category").lean();
    if (!existing) {
      return fail(res, 404, "NOT_FOUND", "Hub not found", null, { requestId: req.requestId });
    }

    const patch = {};
    const { name, h3Cells, city, state, isActive, customerAppEnabled, partnerAppEnabled, categoryId, center } = req.body;

    if (name !== undefined) {
      if (!String(name).trim()) {
        return fail(res, 400, "VALIDATION_ERROR", "Hub name cannot be empty", null, { requestId: req.requestId });
      }
      patch.name = String(name).trim();
    }

    // Resolve the effective category (new one if changing, else the existing).
    let effectiveCategory = existing.category;
    if (categoryId !== undefined) {
      const category = await resolveCategory(categoryId);
      if (!category) {
        return fail(res, 400, "VALIDATION_ERROR", "Select a valid service category for this hub", null, { requestId: req.requestId });
      }
      patch.category = category._id;
      patch.categoryName = category.name;
      effectiveCategory = category._id;
    }

    const cellsChanged = h3Cells !== undefined;
    const categoryChanged =
      categoryId !== undefined && String(effectiveCategory) !== String(existing.category);

    let cells = existing.h3Cells || [];
    if (cellsChanged) {
      cells = cleanCells(h3Cells);
      if (!cells.length) {
        return fail(res, 400, "VALIDATION_ERROR", "A hub must have at least one cell", null, { requestId: req.requestId });
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

    // Re-check conflicts whenever the cells OR the category change, scoped to
    // the (possibly new) category. Different-category hubs may overlap freely.
    if (cellsChanged || categoryChanged) {
      const conflicts = await findCellConflicts(cells, effectiveCategory, id);
      if (conflicts.length) {
        return fail(res, 409, "CELL_CONFLICT", `${conflicts.length} cell(s) already belong to another hub in this service.`, null, { requestId: req.requestId });
      }
    }

    if (city  !== undefined) patch.city  = String(city);
    if (state !== undefined) patch.state = String(state);
    if (isActive !== undefined) patch.isActive = Boolean(isActive);
    if (customerAppEnabled !== undefined) patch.customerAppEnabled = Boolean(customerAppEnabled);
    if (partnerAppEnabled  !== undefined) patch.partnerAppEnabled  = Boolean(partnerAppEnabled);

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
