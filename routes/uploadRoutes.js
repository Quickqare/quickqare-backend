const router = require("express").Router();
const upload = require("../config/multer");
const { uploadImage } = require("../controllers/uploadController");
const authenticateAdmin = require("../admin/middleware/authenticateAdmin");

// Auth runs BEFORE multer so an unauthenticated request is rejected before the
// file is ever streamed to Cloudinary (was previously a fully open endpoint:
// anyone could push files to Cloudinary at our cost).
router.post("/", authenticateAdmin, upload.single("image"), uploadImage);

module.exports = router;
