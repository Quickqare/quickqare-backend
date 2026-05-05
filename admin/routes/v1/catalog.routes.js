const express = require("express");
const mongoose = require("mongoose");
const CatalogItem = require("../../../models/CatalogItem");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { success, fail } = require("../../utils/response");

const router = express.Router();
router.use(authenticateAdmin, authorize(PERMISSIONS.PARTNERS_APPROVE));

/* ── List all ── */
router.get("/", async (req, res) => {
  try {
    const rows = await CatalogItem.find().sort({ sortOrder: 1, name: 1 }).lean();
    return success(res, rows, { requestId: req.requestId });
  } catch (err) {
    return fail(res, 500, "CATALOG_LIST_FAILED", "Unable to fetch catalog", err.message, { requestId: req.requestId });
  }
});

/* ── Create ── */
router.post("/", audit("admin.catalog.create"), async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const price = Number(req.body.priceInr);
    if (!name) return fail(res, 400, "VALIDATION_ERROR", "name is required", null, { requestId: req.requestId });
    if (!Number.isFinite(price) || price < 0) return fail(res, 400, "VALIDATION_ERROR", "priceInr must be a non-negative number", null, { requestId: req.requestId });

    const row = await CatalogItem.create({
      name,
      priceInr: price,
      unit: String(req.body.unit || "piece").trim(),
      description: String(req.body.description || "").trim(),
      isActive: req.body.isActive !== false,
      sortOrder: Number(req.body.sortOrder) || 0,
    });
    return success(res, row, { requestId: req.requestId });
  } catch (err) {
    return fail(res, 500, "CATALOG_CREATE_FAILED", "Unable to create item", err.message, { requestId: req.requestId });
  }
});

/* ── Update ── */
router.patch("/:id", audit("admin.catalog.update"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return fail(res, 400, "INVALID_ID", "Invalid id", null, { requestId: req.requestId });

    const patch = {};
    if (typeof req.body.name === "string" && req.body.name.trim()) patch.name = req.body.name.trim();
    if (req.body.priceInr !== undefined) {
      const p = Number(req.body.priceInr);
      if (!Number.isFinite(p) || p < 0) return fail(res, 400, "VALIDATION_ERROR", "priceInr must be a non-negative number", null, { requestId: req.requestId });
      patch.priceInr = p;
    }
    if (typeof req.body.unit === "string" && req.body.unit.trim()) patch.unit = req.body.unit.trim();
    if (typeof req.body.description === "string") patch.description = req.body.description.trim();
    if (req.body.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);
    if (req.body.sortOrder !== undefined) patch.sortOrder = Number(req.body.sortOrder) || 0;

    const row = await CatalogItem.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
    if (!row) return fail(res, 404, "NOT_FOUND", "Item not found", null, { requestId: req.requestId });
    return success(res, row, { requestId: req.requestId });
  } catch (err) {
    return fail(res, 500, "CATALOG_UPDATE_FAILED", "Unable to update item", err.message, { requestId: req.requestId });
  }
});

/* ── Delete ── */
router.delete("/:id", audit("admin.catalog.delete"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return fail(res, 400, "INVALID_ID", "Invalid id", null, { requestId: req.requestId });
    const row = await CatalogItem.findByIdAndDelete(id).lean();
    if (!row) return fail(res, 404, "NOT_FOUND", "Item not found", null, { requestId: req.requestId });
    return success(res, { deleted: true }, { requestId: req.requestId });
  } catch (err) {
    return fail(res, 500, "CATALOG_DELETE_FAILED", "Unable to delete item", err.message, { requestId: req.requestId });
  }
});

module.exports = router;
