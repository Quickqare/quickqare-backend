const express = require("express");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const {
  getAdminBanners,
  createBanner,
  updateBanner,
  deleteBanner,
} = require("../../../controllers/banner.controller");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.SERVICES_MANAGE));

router.get("/", getAdminBanners);
router.post("/", audit("admin.banners.create"), createBanner);
router.patch("/:id", audit("admin.banners.update"), updateBanner);
router.delete("/:id", audit("admin.banners.delete"), deleteBanner);

module.exports = router;
