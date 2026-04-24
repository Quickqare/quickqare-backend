const { fail } = require("../utils/response");

module.exports = function authorize(permission) {
  return function roleGuard(req, res, next) {
    if (!req.adminUser) {
      return fail(res, 401, "ADMIN_UNAUTHORIZED", "Admin authentication required", null, {
        requestId: req.requestId,
      });
    }

    if (!req.adminUser.permissions.includes(permission)) {
      return fail(res, 403, "ADMIN_FORBIDDEN", "Insufficient permission", null, {
        requestId: req.requestId,
      });
    }

    return next();
  };
};
