const jwt = require("jsonwebtoken");
const AdminUser = require("../models/AdminUser");
const { getPermissionsForRole } = require("../constants/permissions");
const { asSingleString } = require("../utils/common");
const { fail } = require("../utils/response");

module.exports = async function authenticateAdmin(req, res, next) {
  try {
    const authHeader = asSingleString(req.headers.authorization) || "";
    if (!authHeader.startsWith("Bearer ")) {
      return fail(res, 401, "ADMIN_UNAUTHORIZED", "Missing bearer token", null, {
        requestId: req.requestId,
      });
    }

    const token = authHeader.slice(7);
    const accessSecret = process.env.ADMIN_JWT_ACCESS_SECRET || process.env.JWT_SECRET;
    if (!accessSecret) {
      return fail(res, 500, "ADMIN_SECRET_MISSING", "Admin auth secret not configured", null, {
        requestId: req.requestId,
      });
    }

    const payload = jwt.verify(token, accessSecret);
    if (payload.type !== "access") {
      return fail(res, 401, "ADMIN_TOKEN_INVALID", "Invalid access token", null, {
        requestId: req.requestId,
      });
    }

    const admin = await AdminUser.findById(payload.sub).lean();
    if (!admin || !admin.isActive) {
      return fail(res, 401, "ADMIN_INACTIVE", "Admin account is inactive", null, {
        requestId: req.requestId,
      });
    }

    req.adminUser = {
      id: String(admin._id),
      email: admin.email,
      role: admin.role,
      permissions: getPermissionsForRole(admin.role),
    };

    return next();
  } catch (error) {
    return fail(res, 401, "ADMIN_UNAUTHORIZED", "Unauthorized admin", null, {
      requestId: req.requestId,
    });
  }
};
