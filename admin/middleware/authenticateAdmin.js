const jwt = require("jsonwebtoken");
const AdminUser = require("../models/AdminUser");
const AdminSession = require("../models/AdminSession");
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
    const accessSecret = process.env.ADMIN_JWT_ACCESS_SECRET;
    if (!accessSecret) {
      // Startup misconfiguration — never fall back to the user JWT secret.
      return fail(res, 500, "ADMIN_SECRET_MISSING", "ADMIN_JWT_ACCESS_SECRET is not configured", null, {
        requestId: req.requestId,
      });
    }

    const payload = jwt.verify(token, accessSecret);
    if (payload.type !== "access") {
      return fail(res, 401, "ADMIN_TOKEN_INVALID", "Invalid access token", null, {
        requestId: req.requestId,
      });
    }

    // Access tokens issued after the security update carry the session id (sid).
    // Reject any token without one — the admin client auto-refreshes on 401, so
    // a pre-update token is transparently re-minted as a session-bound token.
    if (!payload.sid) {
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

    // Session-bind the token: a revoked or expired session invalidates its access
    // tokens at once, so logout / "revoke all sessions" takes effect immediately
    // instead of lingering until the short-lived access token expires.
    const session = await AdminSession.findById(payload.sid).lean();
    if (
      !session ||
      session.isRevoked ||
      (session.refreshExpiresAt && session.refreshExpiresAt < new Date())
    ) {
      return fail(res, 401, "ADMIN_SESSION_INVALID", "Session is no longer valid", null, {
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
