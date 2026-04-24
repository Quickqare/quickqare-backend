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
      allowed_formats: ["jpg", "png", "jpeg"],
    },
  });
}

module.exports = multer({ storage });
