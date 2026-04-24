const AuditLog = require("../models/AuditLog");
const { asSingleString } = require("../utils/common");

const SENSITIVE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

module.exports = function audit(action) {
  return async function writeAudit(req, _res, next) {
    if (!SENSITIVE_METHODS.has(req.method)) return next();
    if (!req.adminUser) return next();

    try {
      await AuditLog.create({
        actorAdminId: req.adminUser.id,
        action,
        entityType: req.baseUrl || "admin",
        entityId: asSingleString(req.params.id) || null,
        requestId: req.requestId,
        ipAddress: req.ip || "",
        userAgent: asSingleString(req.headers["user-agent"]) || "",
        beforeState: null,
        afterState: JSON.stringify({ body: req.body || {} }),
        metadata: JSON.stringify({ query: req.query || {} }),
      });
    } catch (error) {
      console.error("[admin:audit] failed", error.message);
    }

    return next();
  };
};
