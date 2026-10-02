const router = require("express").Router();
const upload = require("../config/multer");
const { uploadImage, uploadImages } = require("../controllers/uploadController");
const authenticateAdmin = require("../admin/middleware/authenticateAdmin");

// Folders an admin caller may target via ?folder=... — whitelisted so a typo
// (or a tampered request) can't scatter files into arbitrary bucket prefixes.
// Unknown/missing folder falls back to "media" rather than failing the upload.
const GENERAL_FOLDERS = new Set(["services", "banners", "notifications", "settings", "media"]);

// Resolve the storage folder BEFORE multer runs — the multer key generator
// reads req.uploadFolder when building the R2 object key (config/multer.js).
const folderFromQuery = (req, _res, next) => {
  const requested = String(req.query.folder || "").trim().toLowerCase();
  req.uploadFolder = GENERAL_FOLDERS.has(requested) ? requested : "media";
  next();
};

// Auth runs BEFORE multer so an unauthenticated request is rejected before the
// file is ever streamed to storage (was previously a fully open endpoint:
// anyone could push files to it at our cost).
router.post("/", authenticateAdmin, folderFromQuery, upload.single("image"), uploadImage);

// Multi-image upload for service photo galleries (max 12 per request).
router.post("/multi", authenticateAdmin, folderFromQuery, upload.array("images", 12), uploadImages);

module.exports = router;
