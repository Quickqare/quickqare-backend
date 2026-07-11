const multer = require("multer");
const multerS3 = require("multer-s3");
const r2Client = require("./r2");

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
    contentType: multerS3.AUTO_CONTENT_TYPE,
    // Keys are unique and never rewritten (a re-upload mints a new key), so
    // clients may cache forever — saves R2 Class B reads on repeat views.
    cacheControl: "public, max-age=31536000, immutable",
    key: (_req, file, cb) => {
      const ext = file.originalname.split(".").pop().toLowerCase() || "jpg";
      const folder = file.fieldname === "selfie" ? "selfies" : "kyc";
      const filename = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
      cb(null, filename);
    },
  }),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

module.exports = r2Upload;
