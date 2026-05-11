const crypto = require("crypto");
const Booking = require("../models/Booking");
const { assignBooking } = require("../services/assignmentEngine");
const { buildDateTime } = require("../services/scheduling_service");
const { releaseSlotCapacityByBookingId, markSlotLockPaid } = require("../services/slotCapacity.service");
const { recordCouponRedemption } = require("../services/coupon.service");

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

    const scheduledStart = booking.scheduledStartAt 
      ? new Date(booking.scheduledStartAt) 
      : buildDateTime(booking.scheduledDate, booking.scheduledTime);

    const timeToServiceMs = scheduledStart.getTime() - Date.now();
    const hoursToService = timeToServiceMs / (1000 * 60 * 60);

    const newStatus = hoursToService > 24 ? "QUEUED" : "PENDING_ASSIGNMENT";

    // ATOMIC UPDATE: Prevent duplicate webhook & client requests from running assignment twice
    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: bookingId, "payment.status": { $ne: "PAID" } },
      {
        $set: {
          status: newStatus,
          "payment.razorpay_payment_id": razorpay_payment_id,
          "payment.razorpay_order_id": razorpay_order_id,
          "payment.razorpay_signature": razorpay_signature,
          "payment.status": "PAID"
        }
      },
      { new: true }
    );

    if (!updatedBooking) {
      return res.json({
        success: true,
        message: "Payment already verified",
        bookingId: booking._id,
      });
    }

    await markSlotLockPaid(updatedBooking._id);
    updatedBooking.lockedUntil = null;
    updatedBooking.slotReservationExpiresAt = null;
    await updatedBooking.save();

    // Record coupon redemption — previously only the dead verifyPayment in
    // payment.controller.js did this, so production was paying through coupons
    // without ever marking them used. Fail-soft: a redemption-tracking error
    // must not undo a successful payment.
    if (updatedBooking.couponId && updatedBooking.couponCode) {
      try {
        await recordCouponRedemption({
          couponId: updatedBooking.couponId,
          bookingId: updatedBooking._id,
          customerId: updatedBooking.user,
          discountAmountInr:
            updatedBooking.discountAmount ||
            updatedBooking.couponDiscountAmount ||
            0,
        });
      } catch (couponErr) {
        console.error(
          "[payment-verify] recordCouponRedemption failed (non-fatal):",
          couponErr.message
        );
      }
    }

    // Notify the customer so BookingStatusScreen flips off PENDING_PAYMENT
    // immediately instead of waiting for the next poll.
    if (global.io) {
      global.io.to(`user_${updatedBooking.user}`).emit("booking_update", {
        bookingId: updatedBooking._id.toString(),
        status: hoursToService > 24 ? "QUEUED" : "SEARCHING",
        paymentConfirmed: true,
      });
    }

    if (hoursToService > 24) {
      return res.json({
        success: true,
        message: "Payment verified. Booking queued for partner assignment closer to the service date.",
        bookingId: booking._id,
      });
    } else {
      // Set the public-facing SEARCHING status before assignBooking flips it to
      // ASSIGNING_LOCK → ASSIGNED — gives the customer instant visible feedback.
      await Booking.updateOne(
        { _id: updatedBooking._id, status: "PENDING_ASSIGNMENT" },
        { $set: { status: "SEARCHING" } }
      );

      /* =====================
         AUTO ASSIGN PARTNER
      ===================== */
      await assignBooking(booking._id);

      return res.json({
        success: true,
        message: "Payment verified & searching for partner",
        bookingId: booking._id,
      });
    }
  } catch (error) {
    console.error("Payment verification error:", error);

    return res.status(500).json({
      success: false,
      message: "Payment verification failed",
    });
  }
};
