const express = require("express");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const { ADMIN_ROLES, PERMISSIONS, ROLE_PERMISSIONS } = require("../../constants/permissions");
const { success } = require("../../utils/response");

const router = express.Router();

// Per-route guard: like settings.routes, this router is mounted at "/", where a
// path-less router.use() would run for every later router's requests too.
const readRoles = [authenticateAdmin, authorize(PERMISSIONS.ROLES_READ)];

router.get("/roles", readRoles, async (req, res) => {
  return success(
    res,
    Object.values(ADMIN_ROLES).map((role) => ({ role, permissions: ROLE_PERMISSIONS[role] || [] })),
    { requestId: req.requestId }
  );
});

router.get("/permissions", readRoles, async (req, res) => {
  return success(res, Object.values(PERMISSIONS), { requestId: req.requestId });
});

module.exports = router;
