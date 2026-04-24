const express = require("express");
const router = express.Router();

const partnerAuth = require("../middlewares/partnerAuth");
const partnerController = require("../controllers/partner.controller");

/* =====================================================
   PARTNER JOB LIFECYCLE ROUTES (PRODUCTION READY)
   Base: /api/partner
===================================================== */

/**
 * ======================================
 * UPDATE FCM TOKEN
 * PATCH /api/partner/update-fcm
 * ======================================
 */
router.patch(
  "/update-fcm",
  partnerAuth,
  partnerController.updateFcmToken
);

/**
 * ======================================
 * UPDATE PARTNER GPS LOCATION
 * PATCH /api/partner/location
 * Body: { latitude, longitude }
 * ======================================
 */
router.patch(
  "/location",
  partnerAuth,
  partnerController.updateLocation
);

/**
 * ======================================
 * GET SERVICES AVAILABLE AT PARTNER LOCATION
 * GET /api/partner/available-services?latitude=&longitude=
 * ======================================
 */
router.get(
  "/available-services",
  partnerAuth,
  partnerController.getAvailableServicesForLocation
);

router.get(
  "/bookings",
  partnerAuth,
  partnerController.getPartnerBookings
);

router.get(
  "/app-settings",
  partnerController.getPartnerAppSettings
);

/**
 * ======================================
 * ACCEPT BOOKING
 * ASSIGNED → PARTNER_ACCEPTED
 * ======================================
 * POST /api/partner/booking/accept
 */
router.post(
  "/booking/accept",
  partnerAuth,
  partnerController.acceptBooking
);

/**
 * ======================================
 * MARK ON THE WAY
 * PARTNER_ACCEPTED → ON_THE_WAY
 * ======================================
 * POST /api/partner/booking/on-the-way
 */
router.post(
  "/booking/on-the-way",
  partnerAuth,
  partnerController.markOnTheWay
);

/**
 * ======================================
 * START SERVICE
 * ON_THE_WAY → IN_PROGRESS
 * ======================================
 * POST /api/partner/booking/start
 */
router.post(
  "/booking/start",
  partnerAuth,
  partnerController.markInProgress
);

/**
 * ======================================
 * COMPLETE SERVICE
 * IN_PROGRESS → COMPLETED
 * ======================================
 * POST /api/partner/booking/complete
 */
router.post(
  "/booking/complete",
  partnerAuth,
  partnerController.markCompleted
);

module.exports = router;
