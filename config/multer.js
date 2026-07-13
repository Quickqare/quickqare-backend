const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { extFromMime } = require("../utils/imageExt");

// General image uploads (services, cakes, banners, customer reference photos,
// job-start selfies). Storage backend is selectable:
//
//   USE_LOCAL_UPLOADS=true      -> local disk (<backend>/uploads), dev/self-host
//   (default)                   -> Cloudflare R2 via the S3-compatible API
//
// The Cloudinary backend was removed (the `cloudinary` + `multer-storage-cloudinary`
// packages carried unpatched high-severity advisories and were only kept as a
// rollback path we've long since migrated off). A leftover UPLOAD_BACKEND=cloudinary
// now warns and falls through to R2 rather than crashing.
//
// Partner KYC/selfie onboarding uploads have their own R2 multer (config/multerR2).
const useLocal = String(process.env.USE_LOCAL_UPLOADS || "").toLowerCase() === "true";
const backend = String(process.env.UPLOAD_BACKEND || "").trim().toLowerCase();

if (backend === "cloudinary" && !useLocal) {
  console.warn(
    "[multer] UPLOAD_BACKEND=cloudinary is no longer supported — the Cloudinary " +
      "integration was removed. Falling back to Cloudflare R2. Unset UPLOAD_BACKEND " +
      "(or set USE_LOCAL_UPLOADS=true for local disk) to silence this warning."
  );
}

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

function buildStorage() {
  if (useLocal) {
    const uploadDir = path.join(__dirname, "..", "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    return multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadDir),
      filename: (_req, file, cb) => {
        // Extension is forced from the verified MIME type, never the client
        // filename — a ".html"/".svg" upload can't be served as active content.
        const ext = extFromMime(file.mimetype);
        cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
      },
    });
  }

  // Default: Cloudflare R2 (same client/bucket as partner KYC uploads).
  const multerS3 = require("multer-s3");
  const r2Client = require("./r2");
  return multerS3({
    s3: r2Client,
    bucket: process.env.R2_BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    // Keys are unique and never rewritten (a re-upload mints a new key), so
    // browsers + Cloudflare edge may cache forever — repeat views never hit
    // the bucket (saves R2 Class B reads).
    cacheControl: "public, max-age=31536000, immutable",
    key: (req, file, cb) => {
      // Extension from the verified MIME type, not the client filename.
      const ext = extFromMime(file.mimetype);
      // Folder priority: route-resolved req.uploadFolder (see routes/uploadRoutes.js),
      // then "selfie" fieldname → job-selfies (booking start-selfie route),
      // then the catch-all media/.
      const folder =
        req.uploadFolder || (file.fieldname === "selfie" ? "job-selfies" : "media");
      const filename = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
      cb(null, filename);
    },
  });
}

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    const err = new Error("Only JPG, PNG, and WebP images are allowed");
    err.statusCode = 400; // so the global handler returns 400, not 500
    cb(err, false);
  }
};

module.exports = multer({
  storage: buildStorage(),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});
