const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("./cloudinary");

const useLocal = String(process.env.USE_LOCAL_UPLOADS || "").toLowerCase() === "true";

let storage;

if (useLocal) {
  const uploadDir = path.join(__dirname, "..", "uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}_${safeName}`);
    },
  });
} else {
  storage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "quickqare",
      // Must stay in sync with ALLOWED_MIME_TYPES below — otherwise a file the
      // mimetype filter accepts (e.g. webp) gets rejected by Cloudinary as a
      // confusing 500 at upload time.
      allowed_formats: ["jpg", "png", "jpeg", "webp"],
    },
  });
}

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

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
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});
