const multer = require("multer");
const multerS3 = require("multer-s3");
const r2Client = require("./r2");
const { randomUploadName } = require("../utils/imageExt");
const { verifiedImageContentType } = require("../utils/imageContentType");

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only JPG, PNG, and WebP images are allowed"), false);
  }
};

const r2Upload = multer({
  storage: multerS3({
    s3: r2Client,
    bucket: process.env.R2_BUCKET_NAME,
    // Real JPEG/PNG/WebP only, typed from the file's bytes (utils/imageContentType).
    contentType: verifiedImageContentType,
    // Everything here is a personal photo (partner selfie / ID): never let a
    // shared cache (Cloudflare edge, proxies) keep it — the files are served
    // only through short-lived signed links (utils/sensitiveFileUrl).
    cacheControl: "private, max-age=3600",
    key: (_req, file, cb) => {
      // Name = timestamp + CSPRNG suffix; extension from the verified MIME
      // type, never the client filename (utils/imageExt randomUploadName).
      const folder = file.fieldname === "selfie" ? "selfies" : "kyc";
      const filename = `${folder}/${randomUploadName(file.mimetype)}`;
      cb(null, filename);
    },
  }),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

module.exports = r2Upload;
