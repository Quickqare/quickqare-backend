const express = require("express");
const router = express.Router();
const { getPolicy, updatePolicy } = require("../controllers/policy.controller");

// Admin-panel JWT (ADMIN_JWT_ACCESS_SECRET) — writes are gated behind a real
// admin account with the settings.manage permission. Reads stay public.
const authenticateAdmin = require("../admin/middleware/authenticateAdmin");
const authorize = require("../admin/middleware/authorize");
const { PERMISSIONS } = require("../admin/constants/permissions");

// GET: Fetch policy (Used by QuickQare App) — public
router.get("/:type", getPolicy);

// PUT: Create/Update policy (Used by Admin Panel) — admin only
router.put(
  "/:type",
  authenticateAdmin,
  authorize(PERMISSIONS.SETTINGS_MANAGE),
  updatePolicy
);

module.exports = router;
