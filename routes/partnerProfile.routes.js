const express = require("express");
const router = express.Router();

const partnerAuth = require("../middlewares/partnerAuth");
const partnerProfileController = require("../controllers/partnerProfile.controller");

/* =====================================================
   PARTNER PROFILE ROUTES (PRODUCTION READY)
   Base: /api/partner/profile
===================================================== */

/**
 * ======================================
 * GET PARTNER PROFILE
 * GET /api/partner/profile/me
 * ======================================
 */
router.get(
  "/me",
  partnerAuth,
  partnerProfileController.getPartnerProfile
);

router.patch(
  "/me",
  partnerAuth,
  partnerProfileController.updatePartnerProfile
);

/**
 * ======================================
 * UPDATE PARTNER SERVICES + PINCODES
 * PATCH /api/partner/profile/services
 * ======================================
 * Body:
 * {
 *   serviceIds: [],
 *   serviceAreas: []
 * }
 */
router.patch(
  "/services",
  partnerAuth,
  partnerProfileController.updatePartnerServices
);

module.exports = router;
