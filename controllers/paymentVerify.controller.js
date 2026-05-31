const crypto = require("crypto");
const Booking = require("../models/Booking");
const { buildDateTime } = require("../services/scheduling_service");
const { releaseSlotCapacityByBookingId } = require("../services/slotCapacity.service");
const { finalizePaidBooking } = require("../services/paymentFinalize.service");

/* =====================================================
   VERIFY RAZORPAY PAYMENT → AUTO ASSIGN PARTNER
   PRODUCTION READY (MULTI-SERVICE SUPPORT)
===================================================== */
exports.verifyRazorpayPayment = async (req, res) => {
  try {
    const {
      bookingId,
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
    } = req.body;

    /* =====================
       VALIDATE INPUT
    ===================== */
    if (
      !bookingId ||
      !razorpay_payment_id ||
      !razorpay_order_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment verification data missing",
      });
    }

    const booking = await Booking.findById(bookingId)
      .populate("services.serviceId")
      .populate("primaryService");

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    /* =====================
       OWNERSHIP CHECK
       The booking must belong to the authenticated user. The signature check
       below already binds the order to the payment, but scoping by user closes
       the IDOR where one user submits verification against another's booking.
    ===================== */
    if (String(booking.user) !== String(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: "Not authorized for this booking",
      });
    }

    /* =====================
       IDEMPOTENCY GUARD
       Prevent double verification
    ===================== */
    if (booking.payment?.status === "PAID") {
      return res.json({
        success: true,
        message: "Payment already verified",
        bookingId: booking._id,
      });
    }

    /* =====================
       ONLY PENDING BOOKINGS
    ===================== */
    if (booking.status !== "PENDING_PAYMENT") {
      return res.status(400).json({
        success: false,
        message: "Booking is not awaiting payment",
      });
    }

    if (!booking.lockedUntil || new Date(booking.lockedUntil).getTime() <= Date.now()) {
      await releaseSlotCapacityByBookingId(booking._id, {
        releaseReason: "payment_order_expired",
      });
      booking.status = "CANCELLED";
      booking.payment.status = "FAILED";
      booking.cancelledBy = "system";
      booking.cancelReason = "Payment lock expired before verification";
      booking.lockedUntil = null;
      booking.slotReservationExpiresAt = null;
      booking.slotLockId = null;
      booking.slotReservationUnits = 0;
      await booking.save();

      return res.status(409).json({
        success: false,
        message: "Selected slot is no longer available",
      });
    }

    /* =====================
       VERIFY SIGNATURE
    ===================== */
    if (!process.env.RAZORPAY_KEY_SECRET) {
      console.error("[payment] RAZORPAY_KEY_SECRET is not configured");
      return res.status(500).json({ success: false, message: "Payment gateway not configured" });
    }

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      booking.payment.status = "FAILED";
      await releaseSlotCapacityByBookingId(booking._id, {
        releaseReason: "payment_signature_failed",
      });
      booking.lockedUntil = null;
      booking.slotReservationExpiresAt = null;
      booking.slotLockId = null;
      booking.slotReservationUnits = 0;
      await booking.save();

      return res.status(400).json({
        success: false,
        message: "Invalid payment signature",
      });
    }

    // Finalize via the shared service so client verify and the Razorpay webhook
    // always run identical logic. Idempotent — whichever path arrives first wins.
    const { outcome } = await finalizePaidBooking(booking, {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
    });

    if (outcome === "already_paid") {
      return res.json({
        success: true,
        message: "Payment already verified",
        bookingId: booking._id,
      });
    }

    if (outcome === "queued") {
      return res.json({
        success: true,
        message: "Payment verified. Booking queued for partner assignment closer to the service date.",
        bookingId: booking._id,
      });
    }

    return res.json({
      success: true,
      message: "Payment verified & searching for partner",
      bookingId: booking._id,
    });
  } catch (error) {
    console.error("Payment verification error:", error);

    return res.status(500).json({
      success: false,
      message: "Payment verification failed",
    });
  }
};
