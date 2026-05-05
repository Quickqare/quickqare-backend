const express = require("express");
const router = express.Router();
const bookingController = require("../controllers/booking.controller");

const userAuth = require("../middlewares/userAuth");
const partnerAuth = require("../middlewares/partnerAuth");

const validate = require("../middlewares/validate");
const { createBookingValidator } = require("../middlewares/validators");

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

// Get available slots
router.get(
  "/available-slots",
  bookingController.getAvailableSlots
);
router.post(
  "/available-slots",
  bookingController.getAvailableSlots
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

// Body: { otp: "1234" } — OTP given to customer when partner went on-the-way
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

// User cancel
router.patch(
  "/user/cancel/:bookingId",
  userAuth,
  bookingController.cancelBookingByUser
);

module.exports = router;
