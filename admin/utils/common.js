const crypto = require("crypto");

const asSingleString = (value) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
};

const getPagination = (req, defaults = { page: 1, pageSize: 20, maxPageSize: 100 }) => {
  const pageRaw = Number(asSingleString(req.query.page) || defaults.page);
  const pageSizeRaw = Number(asSingleString(req.query.pageSize) || defaults.pageSize);

  const page = Number.isFinite(pageRaw) ? Math.max(pageRaw, 1) : defaults.page;
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.max(1, Math.min(pageSizeRaw, defaults.maxPageSize))
    : defaults.pageSize;

  return { page, pageSize, skip: (page - 1) * pageSize, limit: pageSize };
};

const newRequestId = () => crypto.randomUUID();

// Escape regex metacharacters so a user-supplied search term is matched
// literally in a Mongo $regex query. Without this, input like ".*" or a
// catastrophic-backtracking pattern is interpreted as a regex and can pin the
// DB CPU (ReDoS). Callers still control anchoring / $options.
const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = {
  asSingleString,
  getPagination,
  newRequestId,
  escapeRegex,
};
