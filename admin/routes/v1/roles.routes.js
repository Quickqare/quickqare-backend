const express = require("express");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const { ADMIN_ROLES, PERMISSIONS, ROLE_PERMISSIONS } = require("../../constants/permissions");
const { success } = require("../../utils/response");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.ROLES_READ));

router.get("/roles", async (req, res) => {
  return success(
    res,
    Object.values(ADMIN_ROLES).map((role) => ({ role, permissions: ROLE_PERMISSIONS[role] || [] })),
    { requestId: req.requestId }
  );
});

router.get("/permissions", async (req, res) => {
  return success(res, Object.values(PERMISSIONS), { requestId: req.requestId });
});

module.exports = router;
