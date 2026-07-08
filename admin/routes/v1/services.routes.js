const express = require("express");
const mongoose = require("mongoose");
const Service = require("../../../models/service.model");
const Category = require("../../../models/Category");
const SubCategory = require("../../../models/SubCategory");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { asSingleString } = require("../../utils/common");
const { success, fail } = require("../../utils/response");
const defaultServices = require("../../data/defaultServices");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.SERVICES_MANAGE));

router.get("/", async (req, res) => {
  try {
    const rows = await Service.find().sort({ createdAt: -1 }).lean();

    const categoryIds = rows
      .map((row) => row.category)
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    const subCategoryIds = rows
      .map((row) => row.subCategory)
      .filter((id) => mongoose.Types.ObjectId.isValid(id));

    const [categories, subCategories] = await Promise.all([
      categoryIds.length ? Category.find({ _id: { $in: categoryIds } }).lean() : [],
      subCategoryIds.length ? SubCategory.find({ _id: { $in: subCategoryIds } }).lean() : [],
    ]);

    const categoryMap = new Map(categories.map((c) => [String(c._id), c]));
    const subCategoryMap = new Map(subCategories.map((c) => [String(c._id), c]));

    const data = rows.map((row) => ({
      ...row,
      category:
        categoryMap.get(String(row.category)) ||
        (row.legacyCategory ? { name: row.legacyCategory } : null),
      subCategory: subCategoryMap.get(String(row.subCategory)) || null,
    }));

    return success(res, data, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "SERVICES_LIST_FAILED", "Unable to fetch services", error.message, {
      requestId: req.requestId,
    });
  }
});

router.get("/categories", async (req, res) => {
  try {
    const rows = await Category.find().sort({ name: 1 }).lean();
    return success(res, rows, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "CATEGORIES_LIST_FAILED", "Unable to fetch categories", error.message, {
      requestId: req.requestId,
    });
  }
});

router.get("/subcategories", async (req, res) => {
  try {
    const categoryId = asSingleString(req.query.categoryId);
    const includeInactiveRaw = asSingleString(req.query.includeInactive);
    const includeInactive =
      includeInactiveRaw === undefined ||
      String(includeInactiveRaw).toLowerCase() === "true" ||
      String(includeInactiveRaw) === "1";
    const where = {};
    if (categoryId && mongoose.Types.ObjectId.isValid(categoryId)) {
      where.category = categoryId;
    }
    if (!includeInactive) {
      where.isActive = true;
    }
    const rows = await SubCategory.find(where).sort({ name: 1 }).lean();
    return success(res, rows, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "SUBCATEGORIES_LIST_FAILED", "Unable to fetch subcategories", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post("/categories", audit("admin.services.category.create"), async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) {
      return fail(res, 400, "VALIDATION_ERROR", "name is required", null, { requestId: req.requestId });
    }
    const imageUrl = String(req.body.imageUrl || "").trim();
    const webImageUrl = String(req.body.webImageUrl || "").trim();

    const slug = name.toLowerCase().replace(/\s+/g, "-");
    const existing = await Category.findOne({ $or: [{ name }, { slug }] }).lean();
    if (existing) {
      return success(res, existing, { requestId: req.requestId });
    }

    const row = await Category.create({
      name,
      slug,
      isActive: true,
      ...(imageUrl ? { imageUrl } : {}),
      ...(webImageUrl ? { webImageUrl } : {}),
    });
    return success(res, row, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "CATEGORY_CREATE_FAILED", "Unable to create category", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/categories/:id", audit("admin.services.category.update"), async (req, res) => {
  try {
    const categoryId = asSingleString(req.params.id);
    if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
      return fail(res, 400, "INVALID_ID", "Invalid category id", null, { requestId: req.requestId });
    }

    const patch = {};
    if (typeof req.body.name === "string" && req.body.name.trim()) {
      patch.name = req.body.name.trim();
      patch.slug = req.body.name.trim().toLowerCase().replace(/\s+/g, "-");
    }
    if (typeof req.body.imageUrl === "string") patch.imageUrl = req.body.imageUrl.trim();
    if (typeof req.body.webImageUrl === "string") patch.webImageUrl = req.body.webImageUrl.trim();
    if (req.body.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);

    const row = await Category.findByIdAndUpdate(categoryId, { $set: patch }, { new: true }).lean();
    if (!row) {
      return fail(res, 404, "NOT_FOUND", "Category not found", null, { requestId: req.requestId });
    }

    return success(res, row, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "CATEGORY_UPDATE_FAILED", "Unable to update category", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post("/subcategories", audit("admin.services.subcategory.create"), async (req, res) => {
  try {
    const categoryId = asSingleString(req.body.categoryId);
    const imageUrl = String(req.body.imageUrl || "").trim();
    const singleName = String(req.body.name || "").trim();
    const parsedSingleNames = singleName
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const names = Array.isArray(req.body.names)
      ? req.body.names.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const requestedNames = [...parsedSingleNames, ...names];
    const uniqueNames = [...new Set(requestedNames)];

    if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId) || !uniqueNames.length) {
      return fail(res, 400, "VALIDATION_ERROR", "names[] and valid categoryId are required", null, {
        requestId: req.requestId,
      });
    }

    const created = [];
    const existing = [];

    for (const name of uniqueNames) {
      const row = await SubCategory.findOne({ name, category: categoryId }).lean();
      if (row) {
        existing.push(row);
        continue;
      }

      const inserted = await SubCategory.create({
        name,
        category: categoryId,
        imageUrl,
        isActive: true,
      });
      created.push(inserted);
    }

    return success(
      res,
      {
        created,
        existing,
        createdCount: created.length,
        existingCount: existing.length,
      },
      { requestId: req.requestId }
    );
  } catch (error) {
    return fail(res, 500, "SUBCATEGORY_CREATE_FAILED", "Unable to create subcategory", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/subcategories/:id", audit("admin.services.subcategory.update"), async (req, res) => {
  try {
    const subCategoryId = asSingleString(req.params.id);
    if (!subCategoryId || !mongoose.Types.ObjectId.isValid(subCategoryId)) {
      return fail(res, 400, "INVALID_ID", "Invalid subcategory id", null, { requestId: req.requestId });
    }

    const patch = {};
    if (typeof req.body.name === "string" && req.body.name.trim()) patch.name = req.body.name.trim();
    if (typeof req.body.imageUrl === "string") patch.imageUrl = req.body.imageUrl.trim();
    if (req.body.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);

    const row = await SubCategory.findByIdAndUpdate(subCategoryId, { $set: patch }, { new: true }).lean();
    if (!row) {
      return fail(res, 404, "NOT_FOUND", "Subcategory not found", null, { requestId: req.requestId });
    }

    return success(res, row, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "SUBCATEGORY_UPDATE_FAILED", "Unable to update subcategory", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/subcategories/:id/status", audit("admin.services.subcategory.status"), async (req, res) => {
  try {
    const subCategoryId = asSingleString(req.params.id);
    if (!subCategoryId || !mongoose.Types.ObjectId.isValid(subCategoryId)) {
      return fail(res, 400, "INVALID_ID", "Invalid subcategory id", null, { requestId: req.requestId });
    }

    const isActive = Boolean(req.body.isEnabled);
    const row = await SubCategory.findByIdAndUpdate(
      subCategoryId,
      { $set: { isActive } },
      { new: true }
    ).lean();
    if (!row) {
      return fail(res, 404, "NOT_FOUND", "Subcategory not found", null, { requestId: req.requestId });
    }

    // If subcategory is disabled, disable linked services too.
    if (!isActive) {
      await Service.updateMany({ subCategory: subCategoryId }, { $set: { isActive: false } });
    }

    return success(res, row, { requestId: req.requestId });
  } catch (error) {
    return fail(
      res,
      500,
      "SUBCATEGORY_STATUS_FAILED",
      "Unable to update subcategory status",
      error.message,
      { requestId: req.requestId }
    );
  }
});

router.post("/", audit("admin.services.create"), async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const price = Number(req.body.basePriceInr);
    const commissionPercent = Number(req.body.commissionPercent);
    const categoryId = asSingleString(req.body.categoryId);
    const categoryName = String(req.body.categoryName || "").trim();
    const categoryCode = String(req.body.categoryCode || "").trim();
    const subCategoryId = asSingleString(req.body.subCategoryId);
    const subCategoryName = String(req.body.subCategoryName || "").trim();
    const duration = Number(req.body.duration);

    if (!name || !Number.isFinite(price) || price < 0) {
      return fail(res, 400, "VALIDATION_ERROR", "name and basePriceInr are required", null, {
        requestId: req.requestId,
      });
    }
    if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
      return fail(res, 400, "VALIDATION_ERROR", "commissionPercent must be between 0 and 100", null, {
        requestId: req.requestId,
      });
    }

    let category = null;
    if (categoryId && mongoose.Types.ObjectId.isValid(categoryId)) {
      category = await Category.findById(categoryId).lean();
    } else if (categoryName || categoryCode) {
      const lookup = (categoryName || categoryCode).toLowerCase().replace(/\s+/g, "-");
      category = await Category.findOne({ $or: [{ name: categoryName }, { slug: lookup }] }).lean();
      if (!category) {
        category = await Category.create({
          name: categoryName || categoryCode,
          slug: lookup,
          isActive: true,
        });
      }
    }

    if (!category) {
      return fail(res, 400, "VALIDATION_ERROR", "category is required", null, {
        requestId: req.requestId,
      });
    }

    let subCategory = null;
    if (subCategoryId && mongoose.Types.ObjectId.isValid(subCategoryId)) {
      subCategory = await SubCategory.findById(subCategoryId).lean();
    } else if (subCategoryName) {
      subCategory = await SubCategory.findOne({
        name: subCategoryName,
        category: category._id,
      }).lean();
      if (!subCategory) {
        subCategory = await SubCategory.create({
          name: subCategoryName,
          category: category._id,
        });
      }
    }

    const row = await Service.create({
      name,
      description: String(req.body.description || ""),
      category: category._id,
      subCategory: subCategory?._id,
      legacyCategory: String(category.name || "").toLowerCase(),
      imageUrl: String(req.body.imageUrl || ""),
      webImageUrl: String(req.body.webImageUrl || ""),
      price,
      commissionPercent,
      ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
      isActive: true,
    });

    return success(res, row, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "SERVICE_CREATE_FAILED", "Unable to create service", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post("/seed-defaults", audit("admin.services.seed"), async (req, res) => {
  try {
    const created = [];
    const skipped = [];

    for (const service of defaultServices) {
      const name = String(service.name || "").trim();
      const categoryCode = String(service.categoryCode || "").trim();
      const subCategoryName = String(service.subCategoryName || "").trim();
      const price = Number(service.basePriceInr);
      const commissionPercent = Number(service.commissionPercent);
      const duration = Number(service.duration);

      if (!name || !categoryCode || !Number.isFinite(price) || price < 0) {
        skipped.push({ name, reason: "invalid defaults" });
        continue;
      }

      const existing = await Service.findOne({ name }).lean();
      if (existing) {
        skipped.push({ name, reason: "already exists" });
        continue;
      }

      let category = await Category.findOne({ slug: categoryCode.toLowerCase() });
      if (!category) {
        category = await Category.create({
          name: categoryCode,
          slug: categoryCode.toLowerCase().replace(/\s+/g, "-"),
          isActive: true,
        });
      }

      let subCategory = null;
      if (subCategoryName) {
        subCategory = await SubCategory.findOne({
          name: subCategoryName,
          category: category._id,
        });

        if (!subCategory) {
          subCategory = await SubCategory.create({
            name: subCategoryName,
            category: category._id,
          });
        }
      }

      const row = await Service.create({
        name,
        description: String(service.description || ""),
        category: category._id,
        subCategory: subCategory?._id,
        imageUrl: String(service.imageUrl || ""),
        price,
        commissionPercent: Number.isFinite(commissionPercent) ? commissionPercent : 20,
        ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
        ...(Number(service.minLeadDays) > 0 ? { minLeadDays: Number(service.minLeadDays) } : {}),
        ...(service.cancellationPolicyType ? { cancellationPolicyType: service.cancellationPolicyType } : {}),
        ...(Array.isArray(service.sinceBookingTiers) ? { sinceBookingTiers: service.sinceBookingTiers } : {}),
        ...(Array.isArray(service.ingredients) ? { ingredients: service.ingredients } : {}),
        ...(service.customization ? { customization: service.customization } : {}),
        isActive: true,
      });

      created.push(row);
    }

    return success(res, { createdCount: created.length, skipped }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "SERVICE_SEED_FAILED", "Unable to seed default services", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/:id", audit("admin.services.update"), async (req, res) => {
  try {
    const serviceId = asSingleString(req.params.id);
    if (!serviceId || !mongoose.Types.ObjectId.isValid(serviceId)) {
      return fail(res, 400, "INVALID_ID", "Invalid service id", null, { requestId: req.requestId });
    }

    const patch = {};
    if (typeof req.body.name === "string") patch.name = req.body.name.trim();
    if (typeof req.body.description === "string") patch.description = req.body.description;
    if (typeof req.body.imageUrl === "string") patch.imageUrl = req.body.imageUrl;
    if (typeof req.body.webImageUrl === "string") patch.webImageUrl = req.body.webImageUrl;
    if (req.body.basePriceInr !== undefined) patch.price = Number(req.body.basePriceInr);
    if (req.body.commissionPercent !== undefined) patch.commissionPercent = Number(req.body.commissionPercent);
    if (req.body.isHighlighted !== undefined) patch.isHighlighted = Boolean(req.body.isHighlighted);
    if (req.body.highlightOrder !== undefined) patch.highlightOrder = Number(req.body.highlightOrder) || 0;
    if (req.body.duration !== undefined && Number(req.body.duration) > 0) patch.duration = Number(req.body.duration);
    if (req.body.minLeadDays !== undefined) patch.minLeadDays = Math.max(0, Number(req.body.minLeadDays) || 0);
    if (req.body.isEggless !== undefined) patch.isEggless = Boolean(req.body.isEggless);
    if (Array.isArray(req.body.ingredients)) {
      patch.ingredients = req.body.ingredients
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 50);
    }
    if (Array.isArray(req.body.media360)) {
      patch.media360 = req.body.media360
        .map((url) => String(url || "").trim())
        .filter(Boolean)
        .slice(0, 12);
    }

    const row = await Service.findByIdAndUpdate(serviceId, { $set: patch }, { new: true }).lean();
    if (!row) {
      return fail(res, 404, "NOT_FOUND", "Service not found", null, { requestId: req.requestId });
    }

    return success(res, row, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "SERVICE_UPDATE_FAILED", "Unable to update service", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/:id/status", audit("admin.services.status"), async (req, res) => {
  try {
    const serviceId = asSingleString(req.params.id);
    if (!serviceId || !mongoose.Types.ObjectId.isValid(serviceId)) {
      return fail(res, 400, "INVALID_ID", "Invalid service id", null, { requestId: req.requestId });
    }

    const isActive = Boolean(req.body.isEnabled);
    const row = await Service.findByIdAndUpdate(serviceId, { $set: { isActive } }, { new: true }).lean();
    if (!row) {
      return fail(res, 404, "NOT_FOUND", "Service not found", null, { requestId: req.requestId });
    }

    return success(res, row, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "SERVICE_STATUS_FAILED", "Unable to update service status", error.message, {
      requestId: req.requestId,
    });
  }
});

// PATCH /:id/cancellation-policy — set per-service cancellation tiers
// Body: { tiers: [{ minHoursBefore: 24, refundPercent: 100 }, ...] }
// Optional: policyType ("BEFORE_SERVICE" | "SINCE_BOOKING") and
// sinceBookingTiers: [{ maxHoursAfterBooking, refundPercent }, ...] for
// advance-order categories (cakes).
// Send tiers: [] to reset service to global defaults.
router.patch("/:id/cancellation-policy", audit("admin.services.cancellation"), async (req, res) => {
  try {
    const serviceId = asSingleString(req.params.id);
    if (!serviceId || !mongoose.Types.ObjectId.isValid(serviceId)) {
      return fail(res, 400, "INVALID_ID", "Invalid service id", null, { requestId: req.requestId });
    }

    const tiers = req.body.tiers;
    if (!Array.isArray(tiers)) {
      return fail(res, 400, "INVALID_TIERS", "tiers must be an array", null, { requestId: req.requestId });
    }

    for (const t of tiers) {
      if (typeof t.minHoursBefore !== "number" || typeof t.refundPercent !== "number") {
        return fail(res, 400, "INVALID_TIER", "Each tier must have numeric minHoursBefore and refundPercent", null, { requestId: req.requestId });
      }
      if (t.refundPercent < 0 || t.refundPercent > 100) {
        return fail(res, 400, "INVALID_TIER", "refundPercent must be between 0 and 100", null, { requestId: req.requestId });
      }
      if (t.minHoursBefore < 0) {
        return fail(res, 400, "INVALID_TIER", "minHoursBefore must be >= 0", null, { requestId: req.requestId });
      }
    }

    const set = {
      cancellationTiers: [...tiers].sort((a, b) => b.minHoursBefore - a.minHoursBefore),
    };

    if (req.body.policyType !== undefined) {
      const policyType = String(req.body.policyType);
      if (!["BEFORE_SERVICE", "SINCE_BOOKING"].includes(policyType)) {
        return fail(res, 400, "INVALID_POLICY_TYPE", "policyType must be BEFORE_SERVICE or SINCE_BOOKING", null, { requestId: req.requestId });
      }
      set.cancellationPolicyType = policyType;
    }

    if (req.body.sinceBookingTiers !== undefined) {
      const sinceTiers = req.body.sinceBookingTiers;
      if (!Array.isArray(sinceTiers)) {
        return fail(res, 400, "INVALID_TIERS", "sinceBookingTiers must be an array", null, { requestId: req.requestId });
      }
      for (const t of sinceTiers) {
        if (typeof t.maxHoursAfterBooking !== "number" || typeof t.refundPercent !== "number") {
          return fail(res, 400, "INVALID_TIER", "Each tier must have numeric maxHoursAfterBooking and refundPercent", null, { requestId: req.requestId });
        }
        if (t.refundPercent < 0 || t.refundPercent > 100) {
          return fail(res, 400, "INVALID_TIER", "refundPercent must be between 0 and 100", null, { requestId: req.requestId });
        }
        if (t.maxHoursAfterBooking < 0) {
          return fail(res, 400, "INVALID_TIER", "maxHoursAfterBooking must be >= 0", null, { requestId: req.requestId });
        }
      }
      set.sinceBookingTiers = [...sinceTiers].sort((a, b) => a.maxHoursAfterBooking - b.maxHoursAfterBooking);
    }

    const row = await Service.findByIdAndUpdate(serviceId, { $set: set }, { new: true }).lean();

    if (!row) {
      return fail(res, 404, "NOT_FOUND", "Service not found", null, { requestId: req.requestId });
    }

    return success(
      res,
      {
        cancellationTiers: row.cancellationTiers,
        cancellationPolicyType: row.cancellationPolicyType,
        sinceBookingTiers: row.sinceBookingTiers,
      },
      { requestId: req.requestId }
    );
  } catch (error) {
    return fail(res, 500, "CANCELLATION_POLICY_FAILED", "Unable to update cancellation policy", error.message, {
      requestId: req.requestId,
    });
  }
});

// PATCH /:id/customization — set per-order customization options (cakes)
// Body: { flavours: [{name, priceDelta}], twoTierPriceDelta, addons: [{name, price}], nameOnCakeEnabled }
router.patch("/:id/customization", audit("admin.services.customization"), async (req, res) => {
  try {
    const serviceId = asSingleString(req.params.id);
    if (!serviceId || !mongoose.Types.ObjectId.isValid(serviceId)) {
      return fail(res, 400, "INVALID_ID", "Invalid service id", null, { requestId: req.requestId });
    }

    const body = req.body || {};

    const weights = [];
    if (body.weights !== undefined) {
      if (!Array.isArray(body.weights)) {
        return fail(res, 400, "INVALID_WEIGHTS", "weights must be an array", null, { requestId: req.requestId });
      }
      for (const w of body.weights) {
        const label = String(w?.label || "").trim();
        const priceDelta = Number(w?.priceDelta) || 0;
        if (!label) {
          return fail(res, 400, "INVALID_WEIGHT", "Each weight needs a label", null, { requestId: req.requestId });
        }
        if (priceDelta < 0) {
          return fail(res, 400, "INVALID_WEIGHT", "priceDelta must be >= 0", null, { requestId: req.requestId });
        }
        weights.push({ label, priceDelta });
      }
    }

    const flavours = [];
    if (body.flavours !== undefined) {
      if (!Array.isArray(body.flavours)) {
        return fail(res, 400, "INVALID_FLAVOURS", "flavours must be an array", null, { requestId: req.requestId });
      }
      for (const f of body.flavours) {
        const name = String(f?.name || "").trim();
        const priceDelta = Number(f?.priceDelta) || 0;
        if (!name) {
          return fail(res, 400, "INVALID_FLAVOUR", "Each flavour needs a name", null, { requestId: req.requestId });
        }
        if (priceDelta < 0) {
          return fail(res, 400, "INVALID_FLAVOUR", "priceDelta must be >= 0", null, { requestId: req.requestId });
        }
        flavours.push({ name, priceDelta });
      }
    }

    const addons = [];
    if (body.addons !== undefined) {
      if (!Array.isArray(body.addons)) {
        return fail(res, 400, "INVALID_ADDONS", "addons must be an array", null, { requestId: req.requestId });
      }
      for (const a of body.addons) {
        const name = String(a?.name || "").trim();
        const price = Number(a?.price);
        if (!name || !Number.isFinite(price) || price < 0) {
          return fail(res, 400, "INVALID_ADDON", "Each addon needs a name and a price >= 0", null, { requestId: req.requestId });
        }
        addons.push({ name, price });
      }
    }

    const twoTierPriceDelta = Math.max(0, Number(body.twoTierPriceDelta) || 0);
    const nameOnCakeEnabled = body.nameOnCakeEnabled !== false;

    const row = await Service.findByIdAndUpdate(
      serviceId,
      {
        $set: {
          customization: { weights, flavours, twoTierPriceDelta, addons, nameOnCakeEnabled },
        },
      },
      { new: true }
    ).lean();

    if (!row) {
      return fail(res, 404, "NOT_FOUND", "Service not found", null, { requestId: req.requestId });
    }

    return success(res, { customization: row.customization }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "CUSTOMIZATION_UPDATE_FAILED", "Unable to update customization", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
