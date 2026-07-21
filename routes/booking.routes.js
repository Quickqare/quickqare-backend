const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const bookingController = require("../controllers/booking.controller");
const guestAddonController = require("../controllers/guestAddon.controller");

// Reject a malformed :bookingId up front (400) for EVERY route in this router,
// instead of letting an invalid ObjectId become a CastError that controllers
// catch and report as a 500. Applies to both the /:bookingId reads and the
// partner-lifecycle routes below.
router.param("bookingId", (req, res, next, value) => {
  if (!mongoose.Types.ObjectId.isValid(String(value || ""))) {
    return res.status(400).json({ success: false, message: "Invalid bookingId" });
  }
  return next();
});

const userAuth = require("../middlewares/userAuth");
const partnerAuth = require("../middlewares/partnerAuth");

const validate = require("../middlewares/validate");
const { createBookingValidator } = require("../middlewares/validators");
const { bookingCreateLimiter, slotsLimiter } = require("../middlewares/rateLimiter");
const upload = require("../config/multer");

/* =========================
   USER SIDE
========================= */

/*
PRODUCTION CREATE BOOKING
Now supports:
- multiple services (cart)
- primary service
- backward compatibility
*/
router.post(
  "/create",
  userAuth,
  bookingCreateLimiter,
  createBookingValidator,
  validate,
  bookingController.createBooking
);

// Get my bookings
router.get(
  "/my",
  userAuth,
  bookingController.getMyBookings
);

// Get user active cart (pending booking)
router.get(
  "/active-cart",
  userAuth,
  bookingController.getActiveCart
);

// Get available slots.
//
// Declared BEFORE "/:bookingId": Express matches in registration order, so with
// the param route first, GET /api/booking/available-slots was swallowed by
// getBookingById — which then looked up "available-slots" as an ObjectId. The
// GET route was effectively dead (web uses the POST variant, which is why this
// went unnoticed). Any new static path under /api/booking must go above the
// param route too.
router.get(
  "/available-slots",
  slotsLimiter,
  bookingController.getAvailableSlots
);
router.post(
  "/available-slots",
  slotsLimiter,
  bookingController.getAvailableSlots
);

// Get a single booking by ID
router.get(
  "/:bookingId",
  userAuth,
  bookingController.getBookingById
);

// Track assigned partner live location for a booking
router.get(
  "/:bookingId/partner-location",
  userAuth,
  bookingController.getPartnerLiveLocation
);

// Estimate: fetch pending estimate
router.get(
  "/:bookingId/estimate",
  userAuth,
  bookingController.getEstimate
);

// Estimate: customer approve/reject
router.post(
  "/:bookingId/estimate/respond",
  userAuth,
  bookingController.respondToEstimate
);

// Estimate: pay for an approved estimate (Razorpay order + verify).
// Settlement includes the estimate only once this payment reaches PAID.
router.post(
  "/:bookingId/estimate/create-order",
  userAuth,
  bookingController.createEstimateOrder
);
router.post(
  "/:bookingId/estimate/verify",
  userAuth,
  bookingController.verifyEstimatePayment
);

/* Guest mehendi add-on (partner added on-site) — customer approve & pay / decline */
router.post(
  "/:bookingId/guest-addon/create-order",
  userAuth,
  guestAddonController.createGuestAddonOrder
);
router.post(
  "/:bookingId/guest-addon/verify",
  userAuth,
  guestAddonController.verifyGuestAddonPayment
);
router.post(
  "/:bookingId/guest-addon/decline",
  userAuth,
  guestAddonController.declineGuestAddon
);

/* =========================
   PARTNER SIDE (NO CHANGE)
========================= */

// Partner lifecycle
router.patch(
  "/on-the-way/:bookingId",
  partnerAuth,
  bookingController.markOnTheWay
);

// Optional intermediate state — partner reached customer's door
router.patch(
  "/arrived/:bookingId",
  partnerAuth,
  bookingController.markArrived
);

// Partner uploads on-site selfie (required before start when admin flag is on)
router.post(
  "/start-selfie/:bookingId",
  partnerAuth,
  upload.single("selfie"),
  bookingController.uploadStartSelfie
);

// Partner starts service after arrival
router.patch(
  "/start/:bookingId",
  partnerAuth,
  bookingController.startService
);

router.patch(
  "/complete/:bookingId",
  partnerAuth,
  bookingController.completeBooking
);

// Partner cancel
router.patch(
  "/partner/cancel/:bookingId",
  partnerAuth,
  bookingController.cancelBooking
);

// Partner flags an on-site issue (e.g. customer asked to come later).
// Records an audit entry + notifies ops; does NOT change status/fees/refunds.
router.post(
  "/partner/report-issue/:bookingId",
  partnerAuth,
  bookingController.reportBookingIssue
);

// User cancel
router.patch(
  "/user/cancel/:bookingId",
  userAuth,
  bookingController.cancelBookingByUser
);

// User reschedule (only when status is NEEDS_RESCHEDULING)
router.patch(
  "/user/reschedule/:bookingId",
  userAuth,
  bookingController.rescheduleBooking
);

module.exports = router;
