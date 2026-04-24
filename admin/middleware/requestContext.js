const { asSingleString, newRequestId } = require("../utils/common");

module.exports = function requestContext(req, _res, next) {
  const requestId = asSingleString(req.headers["x-request-id"]);
  req.requestId = requestId || newRequestId();
  next();
};
