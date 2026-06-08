const Partner = require("../models/Partner");
const Service = require("../models/service.model"); // ✅ FIXED IMPORT
const Category = require("../models/Category");
const { deriveH3Cell } = require("../utils/h3");
const { reverseGeocode } = require("../services/geocode.service");

/* =============================
   UPDATE PARTNER SERVICES
   + SERVICE AREAS (PINCODE)
   PRODUCTION READY
============================= */
exports.updatePartnerServices = async (req, res) => {
  try {
    const { serviceIds, serviceAreas, skillTier, mehendiSpecializations } = req.body;

    /* =============================
       VALIDATE INPUT
    ============================= */
    if (!Array.isArray(serviceIds) || serviceIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "serviceIds array required",
      });
    }

    if (!Array.isArray(serviceAreas) || serviceAreas.length === 0) {
      return res.status(400).json({
        success: false,
        message: "serviceAreas array required",
      });
    }

    /* =============================
       REMOVE DUPLICATE IDS
    ============================= */
    const uniqueServiceIds = [...new Set(serviceIds)];

    /* =============================
       VALIDATE SERVICES EXIST
       (ONLY ACTIVE SERVICES)
    ============================= */
    const validServices = await Service.find({
      _id: { $in: uniqueServiceIds },
      isActive: true,
    });

    if (validServices.length !== uniqueServiceIds.length) {
      return res.status(400).json({
        success: false,
        message: "Some services are invalid or inactive",
      });
    }

    /* =============================
       ENFORCE SINGLE CATEGORY
    ============================= */
    const categoryIds = validServices
      .map((service) => (service.category ? String(service.category) : null))
      .filter(Boolean);
    const legacyCategories = validServices
      .map((service) => (service.legacyCategory ? String(service.legacyCategory).toLowerCase() : null))
      .filter(Boolean);

    let serviceCategoryName = "Other";

    if (categoryIds.length > 0) {
      const uniqueCategoryIds = [...new Set(categoryIds)];
      if (uniqueCategoryIds.length !== 1 || categoryIds.length !== validServices.length) {
        return res.status(400).json({
          success: false,
          message: "Only one service category is allowed",
        });
      }

      const category = await Category.findById(uniqueCategoryIds[0]).lean();
      if (!category) {
        return res.status(400).json({
          success: false,
          message: "Invalid service category",
        });
      }
      serviceCategoryName = category.name;
    } else {
      const uniqueLegacy = [...new Set(legacyCategories)];
      if (uniqueLegacy.length !== 1 || legacyCategories.length !== validServices.length) {
        return res.status(400).json({
          success: false,
          message: "Only one service category is allowed",
        });
      }
      serviceCategoryName = uniqueLegacy[0] || "Other";
    }

    /* =============================
       PREPARE PARTNER SERVICES
    ============================= */
    const services = validServices.map((service) => ({
      serviceId: service._id,
      isActive: true,

      // Freeze basic info for faster matching
      name: service.name,
      category: service.category,
      subCategory: service.subCategory,
    }));

    /* =============================
       AC SKILL TIER
       1 = Non-Technician, 2 = Technician
    ============================= */
    const isAcCategory = /\bac\b/i.test(serviceCategoryName);
    const skillTierUpdate = {};

    if (isAcCategory) {
      const tier = Number(skillTier);
      if (tier !== 1 && tier !== 2) {
        return res.status(400).json({
          success: false,
          message: "skillTier is required for AC category (1 = Non-Technician, 2 = Technician)",
        });
      }
      skillTierUpdate.skillTier = tier;
    }

    /* =============================
       MEHENDI SPECIALIZATIONS
       Array of subcategory names e.g. ["Bridal", "Arabic"]
    ============================= */
    const isMehendiCategory = /mehendi/i.test(serviceCategoryName);
    const mehendiUpdate = {};

    if (isMehendiCategory) {
      const specs = Array.isArray(mehendiSpecializations)
        ? mehendiSpecializations.map((s) => String(s).trim()).filter(Boolean)
        : [];
      if (specs.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Select at least one Mehendi specialization (e.g. Bridal, Arabic)",
        });
      }
      mehendiUpdate.mehendiSpecializations = specs;
    }

    /* =============================
       DERIVE H3 SERVICE CELLS
       Silently geocode each service-area pincode to get its
       centroid lat/lng, then convert to an H3 cell index.
       Failures are swallowed — this is best-effort.
    ============================= */
    const h3ServiceCells = [];
    for (const pincode of serviceAreas) {
      try {
        const geo = await reverseGeocode(null, null, "pincode_lookup", pincode);
        if (geo?.ok && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) {
          const cell = deriveH3Cell(geo.lat, geo.lng);
          if (cell) h3ServiceCells.push(cell);
        }
      } catch { /* non-fatal */ }
    }

    /* =============================
       UPDATE PARTNER
    ============================= */
    const partner = await Partner.findByIdAndUpdate(
      req.partner._id,
      {
        services,
        serviceAreas,
        h3ServiceCells: [...new Set(h3ServiceCells)],
        serviceCategories: [serviceCategoryName],
        ...skillTierUpdate,
        ...mehendiUpdate,
      },
      { new: true }
    )
      .populate("services.serviceId")
      .select("-password");

    res.json({
      success: true,
      message: "Services updated successfully",
      partner,
    });
  } catch (error) {
    console.error("Update services error:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/* =============================
   GET PARTNER PROFILE
   (UPDATED FOR MULTI SERVICE)
============================= */
exports.getPartnerProfile = async (req, res) => {
  try {
    const partner = await Partner.findById(req.partner._id)
      .populate("services.serviceId")
      .select("-password");

    if (!partner) {
      return res.status(404).json({
        success: false,
        message: "Partner not found",
      });
    }

    res.json({
      success: true,
      partner,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/* =============================
   UPDATE BASIC PARTNER PROFILE
============================= */
exports.updatePartnerProfile = async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const rawServiceAreas = req.body?.serviceAreas;

    let serviceAreas = [];

    if (Array.isArray(rawServiceAreas)) {
      serviceAreas = rawServiceAreas
        .map((value) => String(value || "").trim())
        .filter(Boolean);
    } else if (typeof rawServiceAreas === "string") {
      serviceAreas = rawServiceAreas
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }

    const partner = await Partner.findById(req.partner._id).select("-password");
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: "Partner not found",
      });
    }

    partner.email = email;
    partner.serviceAreas = [...new Set(serviceAreas)];
    await partner.save();

    return res.json({
      success: true,
      message: "Profile updated successfully",
      partner,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/* =============================
   GET MY HUB  ("Mera Hub" screen)
   GET /api/partner/profile/hub
   Returns the partner's assigned hub with its H3 cell
   boundary geometry so the app can draw the zone polygon.
============================= */
exports.getMyHub = async (req, res) => {
  try {
    const Hub = require("../models/Hub");
    const { cellToBoundary } = require("h3-js");

    const partner = await Partner.findById(req.partner._id)
      .select("name assignedHubId")
      .lean();

    if (!partner) {
      return res.status(404).json({ success: false, message: "Partner not found" });
    }

    if (!partner.assignedHubId) {
      return res.json({ success: true, hub: null, message: "No hub assigned yet" });
    }

    const hub = await Hub.findById(partner.assignedHubId).lean();
    if (!hub || hub.isActive === false) {
      return res.json({ success: true, hub: null, message: "Hub not available" });
    }

    // Build polygon rings — one [lat,lng][] boundary per H3 cell — so the
    // mobile map can render the hub shape without needing h3 libs client-side.
    const cellBoundaries = (hub.h3Cells || []).map((cell) => ({
      cell,
      boundary: cellToBoundary(cell).map(([lat, lng]) => ({ latitude: lat, longitude: lng })),
    }));

    return res.json({
      success: true,
      hub: {
        id: String(hub._id),
        name: hub.name,
        city: hub.city,
        state: hub.state,
        center: hub.center,
        services: hub.services,
        cellCount: (hub.h3Cells || []).length,
        cellBoundaries,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
