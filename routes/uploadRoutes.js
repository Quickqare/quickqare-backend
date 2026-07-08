const router = require("express").Router();
const upload = require("../config/multer");
const { uploadImage, uploadImages } = require("../controllers/uploadController");
const authenticateAdmin = require("../admin/middleware/authenticateAdmin");
const userAuth = require("../middlewares/userAuth");

// Auth runs BEFORE multer so an unauthenticated request is rejected before the
// file is ever streamed to Cloudinary (was previously a fully open endpoint:
// anyone could push files to Cloudinary at our cost).
router.post("/", authenticateAdmin, upload.single("image"), uploadImage);

// Multi-image upload for cake photo galleries (max 12 per request).
router.post("/multi", authenticateAdmin, upload.array("images", 12), uploadImages);

// Customer-facing single-image upload — used for cake "reference photo"
// ("make it look like this"). Gated by userAuth, not admin, since any logged-in
// customer needs this while customizing a cake order.
router.post("/customer", userAuth, upload.single("image"), uploadImage);

module.exports = router;
