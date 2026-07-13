/* =====================================================
   NoSQL INJECTION GUARD (defense-in-depth)
   =====================================================
   Recursively strips any object key that could be a MongoDB query operator
   ("$gt", "$ne", "$where", …) or a dotted path traversal ("a.b") from
   user-controlled input. A payload like  { "phone": { "$gt": "" } }  is
   flattened to  { "phone": {} }  before it can reach a Mongoose query.

   The auth handlers already String()-coerce the security-critical fields, so
   this is a second layer that protects any current/future handler that forgets
   to. It deliberately does NOT pull in express-mongo-sanitize: that package is
   unmaintained and its req.query mutation breaks on newer Express.

   Applied to req.body and req.params (both stable, mutable objects in Express
   4/5). req.query is sanitised separately, at parse time, via a custom
   "query parser" set in index.js — mutating req.query in place is ineffective
   because Express re-derives it from the URL on each access.
========================================================= */

const FORBIDDEN_KEY = (key) => key.startsWith("$") || key.includes(".");

function sanitizeInPlace(value, depth = 0) {
  // Bound recursion so a deeply-nested hostile payload can't blow the stack.
  if (depth > 20 || value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    for (const item of value) sanitizeInPlace(item, depth + 1);
    return value;
  }

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY(key)) {
      delete value[key];
      continue;
    }
    sanitizeInPlace(value[key], depth + 1);
  }
  return value;
}

function sanitizeMongo(req, _res, next) {
  if (req.body) sanitizeInPlace(req.body);
  if (req.params) sanitizeInPlace(req.params);
  next();
}

module.exports = { sanitizeMongo, sanitizeInPlace };
