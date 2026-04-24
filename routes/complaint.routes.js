const express = require("express");
const router = express.Router();
const {
  createComplaint,
  getUserComplaints,
  getComplaintDetails,
} = require("../controllers/complaint.controller");
const userAuth = require("../middlewares/userAuth");
const upload = require("../config/multer");

/**
 * Create a new complaint
 * POST /api/complaints
 */
router.post("/", userAuth, upload.array("images", 5), createComplaint);

/**
 * Get user's complaints
 * GET /api/complaints
 */
router.get("/", userAuth, getUserComplaints);

/**
 * Get complaint details
 * GET /api/complaints/:id
 */
router.get("/:id", userAuth, getComplaintDetails);

module.exports = router;