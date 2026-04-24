const Zone = require("../models/zone.model");

/* =====================================================
   CREATE ZONE (ADMIN - PRODUCTION SAFE)
===================================================== */
exports.createZone = async (req, res) => {
  try {
    const {
      pincode,
      nearbyPincodes = [],
      extendedPincodes = [],
      customerAppEnabled,
      partnerAppEnabled,
    } = req.body;

    /* =====================
       VALIDATE INPUT
    ===================== */
    if (!pincode) {
      return res.status(400).json({
        success: false,
        message: "pincode is required",
      });
    }

    // prevent duplicate zone
    const existingZone = await Zone.findOne({ pincode });
    if (existingZone) {
      return res.status(400).json({
        success: false,
        message: "Zone already exists for this pincode",
      });
    }

    const zone = await Zone.create({
      pincode,
      nearbyPincodes,
      extendedPincodes,
      ...(customerAppEnabled !== undefined && {
        customerAppEnabled: Boolean(customerAppEnabled),
      }),
      ...(partnerAppEnabled !== undefined && {
        partnerAppEnabled: Boolean(partnerAppEnabled),
      }),
    });

    res.status(201).json({
      success: true,
      message: "Zone created successfully",
      zone,
    });
  } catch (err) {
    console.error("Create zone error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* =====================================================
   GET ALL ZONES
===================================================== */
exports.getZones = async (req, res) => {
  try {
    const zones = await Zone.find().sort({ createdAt: -1 });

    res.json({
      success: true,
      count: zones.length,
      zones,
    });
  } catch (err) {
    console.error("Get zones error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* =====================================================
   GET SINGLE ZONE
===================================================== */
exports.getZone = async (req, res) => {
  try {
    const zone = await Zone.findById(req.params.id);

    if (!zone) {
      return res.status(404).json({
        success: false,
        message: "Zone not found",
      });
    }

    res.json({
      success: true,
      zone,
    });
  } catch (err) {
    console.error("Get zone error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* =====================================================
   UPDATE ZONE
===================================================== */
exports.updateZone = async (req, res) => {
  try {
    const zone = await Zone.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    if (!zone) {
      return res.status(404).json({
        success: false,
        message: "Zone not found",
      });
    }

    res.json({
      success: true,
      message: "Zone updated successfully",
      zone,
    });
  } catch (err) {
    console.error("Update zone error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* =====================================================
   DELETE ZONE (SOFT DELETE RECOMMENDED)
===================================================== */
exports.deleteZone = async (req, res) => {
  try {
    const zone = await Zone.findByIdAndDelete(req.params.id);

    if (!zone) {
      return res.status(404).json({
        success: false,
        message: "Zone not found",
      });
    }

    res.json({
      success: true,
      message: "Zone deleted successfully",
    });
  } catch (err) {
    console.error("Delete zone error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
