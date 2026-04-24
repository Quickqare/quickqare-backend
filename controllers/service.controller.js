const Service = require("../models/service.model");
const Category = require("../models/Category");
const SubCategory = require("../models/SubCategory");

/* =====================================================
   CREATE SERVICE (ADMIN - PRODUCTION)
===================================================== */
exports.createService = async (req, res) => {
  try {
    const {
      name,
      description,
      price,
      category,
      subCategory,
      imageUrl,
      duration,
      legacyCategory,
    } = req.body;

    /* =====================
       VALIDATION
    ===================== */
    if (!name || !price) {
      return res.status(400).json({
        success: false,
        message: "name and price are required",
      });
    }

    const service = await Service.create({
      name,
      description,
      price,
      category,
      subCategory,
      imageUrl,
      duration,
      legacyCategory,
    });

    res.status(201).json({
      success: true,
      message: "Service created successfully",
      service,
    });
  } catch (err) {
    console.error("Create service error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* =====================================================
   GET SERVICES (CUSTOMER + PARTNER)
   Supports filters:
   - category
   - subCategory
===================================================== */
exports.getServices = async (req, res) => {
  try {
    const { category, subCategory, includeInactive } = req.query;

    const query = {};
    const shouldIncludeInactive =
      String(includeInactive || "").toLowerCase() === "true" ||
      String(includeInactive || "") === "1";

    if (!shouldIncludeInactive) {
      query.isActive = true;

      // Hide services linked to disabled subcategories.
      const activeSubCategories = await SubCategory.find({ isActive: true })
        .select("_id")
        .lean();
      const activeSubCategoryIds = activeSubCategories.map((item) => item._id);

      query.$or = [
        { subCategory: { $exists: false } },
        { subCategory: null },
        { subCategory: { $in: activeSubCategoryIds } },
      ];
    }

    if (category) query.category = category;
    if (subCategory) query.subCategory = subCategory;

    const services = await Service.find(query)
      .populate("category")
      .populate("subCategory")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: services.length,
      services,
    });
  } catch (err) {
    console.error("Get services error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* =====================================================
   GET SINGLE SERVICE
===================================================== */
exports.getServiceById = async (req, res) => {
  try {
    const service = await Service.findById(req.params.id)
      .populate("category")
      .populate("subCategory");

    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    res.json({
      success: true,
      service,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* =====================================================
   GET CATEGORIES (PUBLIC)
===================================================== */
exports.getCategories = async (_req, res) => {
  try {
    const categories = await Category.find({ isActive: true }).sort({ name: 1 });
    res.json({ success: true, count: categories.length, categories });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   GET SUBCATEGORIES (PUBLIC)
===================================================== */
exports.getSubCategories = async (req, res) => {
  try {
    const { categoryId, includeInactive } = req.query;
    const query = {};
    const shouldIncludeInactive =
      String(includeInactive || "").toLowerCase() === "true" ||
      String(includeInactive || "") === "1";

    if (!shouldIncludeInactive) {
      query.isActive = true;
    }

    if (categoryId) {
      query.category = categoryId;
    }
    const subCategories = await SubCategory.find(query).sort({ name: 1 });
    res.json({ success: true, count: subCategories.length, subCategories });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   UPDATE SERVICE (ADMIN)
===================================================== */
exports.updateService = async (req, res) => {
  try {
    const service = await Service.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    res.json({
      success: true,
      message: "Service updated successfully",
      service,
    });
  } catch (err) {
    console.error("Update service error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* =====================================================
   DELETE SERVICE (ADMIN)
   Soft delete for production safety
===================================================== */
exports.deleteService = async (req, res) => {
  try {
    const service = await Service.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );

    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    res.json({
      success: true,
      message: "Service deleted successfully",
    });
  } catch (err) {
    console.error("Delete service error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
