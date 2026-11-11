const crypto = require("crypto");

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

// Stored file name: timestamp + 128 bits from the CSPRNG. Uploads (partner
// selfies, job-spot photos, KYC) live at public, unauthenticated URLs unless
// R2_PRIVATE_UPLOADS is on, so the name is the only thing protecting a file.
// It used to be Math.random(), whose V8 generator state can be recovered from
// a few observed outputs (e.g. the names of one's own uploads), making other
// people's file names predictable.
function randomUploadName(mimetype) {
  return `${Date.now()}_${crypto.randomBytes(16).toString("hex")}.${extFromMime(mimetype)}`;
}

module.exports = { extFromMime, randomUploadName, MIME_TO_EXT };
