const express = require("express");
const router = express.Router();
const Policy = require("../../../models/Policy");
const { resolveDefaultPolicy } = require("../../../services/policyDefaults.service");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const { PERMISSIONS } = require("../../constants/permissions");
const authorize = require("../../middleware/authorize");

// GET /api/v1/admin/policies/:type
router.get("/:type",
  authenticateAdmin,
  authorize(PERMISSIONS.SETTINGS_MANAGE),
  async (req, res) => {
    try {
      const type = req.params.type.toLowerCase();
      const policy = await Policy.findOne({ type });
      const fallback = resolveDefaultPolicy(type);

      return res.json({
        success: true,
        data: policy || {
          type,
          content: fallback?.content || "",
          title: fallback?.title || "",
        },
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

// POST /api/v1/admin/policies/:type  — create or update
router.post("/:type",
  authenticateAdmin,
  authorize(PERMISSIONS.SETTINGS_MANAGE),
  async (req, res) => {
    try {
      const { content, title } = req.body;
      const type = req.params.type.toLowerCase();
      const fallback = resolveDefaultPolicy(type);

      const policy = await Policy.findOneAndUpdate(
        { type },
        {
          content: content || fallback?.content || "",
          title: title || fallback?.title || type,
          lastUpdatedBy: req.admin?._id,
        },
        { upsert: true, new: true, runValidators: true }
      );

      return res.json({ success: true, data: policy });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
