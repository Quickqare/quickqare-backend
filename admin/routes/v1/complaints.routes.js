const express = require("express");
const router = express.Router();
const {
  getAllComplaints,
  getComplaintDetailsAdmin,
  updateComplaintStatus,
  addComplaintResolution,
} = require("../../../controllers/adminComplaint.controller");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const { PERMISSIONS } = require("../../constants/permissions");

/**
 * Get all complaints
 * GET /api/v1/admin/complaints
 */
router.get("/",
  authenticateAdmin,
  authorize(PERMISSIONS.COMPLAINTS_VIEW),
  getAllComplaints
);

/**
 * Get complaint details
 * GET /api/v1/admin/complaints/:id
 */
router.get("/:id",
  authenticateAdmin,
  authorize(PERMISSIONS.COMPLAINTS_VIEW),
  getComplaintDetailsAdmin
);

/**
 * Update complaint status
 * PATCH /api/v1/admin/complaints/:id/status
 */
router.patch("/:id/status",
  authenticateAdmin,
  authorize(PERMISSIONS.COMPLAINTS_UPDATE),
  updateComplaintStatus
);

/**
 * Add/update complaint resolution
 * PATCH /api/v1/admin/complaints/:id/resolution
 */
router.patch("/:id/resolution",
  authenticateAdmin,
  authorize(PERMISSIONS.COMPLAINTS_UPDATE),
  addComplaintResolution
);

module.exports = router;
