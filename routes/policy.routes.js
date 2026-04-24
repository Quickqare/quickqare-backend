const express = require("express");
const router = express.Router();
const { getPolicy, updatePolicy } = require("../controllers/policy.controller");

// Middleware placeholder - ensure only admins can update policies
// const { verifyAdmin } = require("../middleware/auth");

// GET: Fetch policy (Used by QuickQare App)
router.get("/:type", getPolicy);

// PUT: Create/Update policy (Used by Admin Panel)
// router.put("/:type", verifyAdmin, updatePolicy); 
router.put("/:type", updatePolicy); // Add verifyAdmin middleware when ready

module.exports = router;