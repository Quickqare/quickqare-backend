const AuditLog = require("../models/AuditLog");
const { asSingleString } = require("../utils/common");

const SENSITIVE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// The request body is stored with each entry — never with a password in it.
const SECRET_FIELDS = new Set(["password", "newPassword", "currentPassword"]);
const withoutSecrets = (body) =>
  Object.fromEntries(
    Object.entries(body || {}).map(([key, value]) => [key, SECRET_FIELDS.has(key) ? "[redacted]" : value])
  );

module.exports = function audit(action) {
  return async function writeAudit(req, res, next) {
    if (!SENSITIVE_METHODS.has(req.method)) return next();
    if (!req.adminUser) return next();

    try {
      // Written BEFORE the handler runs, so even a request that takes the
      // process down leaves a trace of who tried what.
      const entry = await AuditLog.create({
        actorAdminId: req.adminUser.id,
        action,
        entityType: req.baseUrl || "admin",
        entityId: asSingleString(req.params.id) || asSingleString(req.params.type) || null,
        requestId: req.requestId,
        ipAddress: req.ip || "",
        userAgent: asSingleString(req.headers["user-agent"]) || "",
        beforeState: null,
        afterState: JSON.stringify({ body: withoutSecrets(req.body) }),
        metadata: JSON.stringify({ query: req.query || {} }),
      });

      // …and completed once the response is sent, with how it actually went.
      // Without this a refused or crashed action read exactly like one that worked.
      res.once("finish", () => {
        AuditLog.updateOne(
          { _id: entry._id },
          { $set: { statusCode: res.statusCode, outcome: res.statusCode < 400 ? "success" : "failed" } }
        ).catch((error) => console.error("[admin:audit] outcome failed", error.message));
      });
    } catch (error) {
      console.error("[admin:audit] failed", error.message);
    }

    return next();
  };
};
