const express = require("express");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const {
  getOffers,
  createOffer,
  updateOffer,
  deleteOffer,
} = require("../../controllers/offer.controller");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.SERVICES_MANAGE));

router.get("/", getOffers);
router.post("/", audit("admin.offers.create"), createOffer);
router.patch("/:id", audit("admin.offers.update"), updateOffer);
router.delete("/:id", audit("admin.offers.delete"), deleteOffer);

module.exports = router;
