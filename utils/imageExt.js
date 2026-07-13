// Map a validated image MIME type to a safe file extension.
//
// The stored extension must come from the server-verified MIME type, NOT from
// the client-supplied filename. Trusting the filename let a caller upload
// "evil.html" (declared image/png) and have it stored with a .html extension —
// which, when later served from /uploads (local-disk mode) or a bucket with
// content-type inference, executes as HTML in the browser (stored XSS on our
// origin). The multer fileFilter already restricts mimetype to this set, so an
// unknown type never reaches here; "jpg" is a defensive fallback only.
const MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function extFromMime(mimetype) {
  return MIME_TO_EXT[String(mimetype || "").toLowerCase()] || "jpg";
}

module.exports = { extFromMime, MIME_TO_EXT };
