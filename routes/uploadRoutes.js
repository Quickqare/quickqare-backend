const router = require("express").Router();
const upload = require("../config/multer");
const { uploadImage, uploadImages } = require("../controllers/uploadController");
const authenticateAdmin = require("../admin/middleware/authenticateAdmin");
const { PERMISSIONS } = require("../admin/constants/permissions");
const { fail } = require("../admin/utils/response");

// Uploads feed the catalog, banner, notification and settings screens, so they
// are for admins who can manage one of those — not for every signed-in admin
// (a support or finance login has no screen that uploads anything).
const UPLOAD_PERMISSIONS = [PERMISSIONS.SERVICES_MANAGE, PERMISSIONS.SETTINGS_MANAGE];
const canUpload = (req, res, next) =>
  UPLOAD_PERMISSIONS.some((permission) => req.adminUser.permissions.includes(permission))
    ? next()
    : fail(res, 403, "ADMIN_FORBIDDEN", "Insufficient permission", null, { requestId: req.requestId });

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
router.post("/", authenticateAdmin, canUpload, folderFromQuery, upload.single("image"), uploadImage);

// Multi-image upload for service photo galleries (max 12 per request).
router.post("/multi", authenticateAdmin, canUpload, folderFromQuery, upload.array("images", 12), uploadImages);

module.exports = router;
