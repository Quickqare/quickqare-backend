const Razorpay = require("razorpay");
const Booking = require("../models/Booking");
const { releaseSlotCapacityByBookingId } = require("../services/slotCapacity.service");

/* =====================================================
   CREATE RAZORPAY ORDER
   (UPDATED FOR MULTI-SERVICE BOOKINGS)
===================================================== */
exports.createOrder = async (req, res) => {
  try {
    const AdminSetting = require("../admin/models/AdminSetting");
    const settings = await AdminSetting.findOne().lean();
    if (settings?.emergencyLockdown || settings?.paymentsFreezed) {
      return res.status(503).json({
        success: false,
        message: settings?.emergencyLockdown
          ? "Service temporarily unavailable. Please try again later."
          : "Payments are temporarily frozen. Please try again later.",
      });
    }

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({
        success: false,
        message: "Razorpay not configured",
      });
    }

    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: "bookingId is required",
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
       PREVENT DOUBLE PAYMENT
    ===================== */
    if (booking.payment?.status === "PAID") {
      return res.status(400).json({
        success: false,
        message: "Booking already paid",
      });
    }

    if (booking.status !== "PENDING_PAYMENT") {
      return res.status(400).json({
        success: false,
        message: "Booking is not eligible for payment",
      });
    }

    if (!booking.lockedUntil || new Date(booking.lockedUntil).getTime() <= Date.now()) {
      await releaseSlotCapacityByBookingId(booking._id, {
        releaseReason: "payment_order_expired",
      });
      booking.status = "CANCELLED";
      booking.payment.status = "FAILED";
      booking.cancelledBy = "system";
      booking.cancelReason = "Payment lock expired before order creation";
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
       CREATE RAZORPAY ORDER
    ===================== */
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const order = await razorpay.orders.create({
      // Math.round — Razorpay rejects non-integer paise amounts. Without this,
      // a totalAmount like 1180.5 produces 118050.0 (a float) and the order
      // create silently fails.
      amount: Math.round(Number(booking.totalAmount || 0) * 100),
      currency: "INR",
      receipt: `booking_${booking._id}`,
    });

    /* =====================
       SAVE ORDER ID
    ===================== */
    booking.payment.razorpay_order_id = order.id;
    booking.payment.status = "PENDING";
    await booking.save();

    return res.json({
      success: true,
      order: {
        ...order,
        key_id: process.env.RAZORPAY_KEY_ID, // expose key so client never needs to hardcode it
      },
      booking,
      pricing: {
        baseAmount: booking.baseAmount,
        discountAmount: booking.discountAmount,
        platformFeeAmount: booking.platformFeeAmount,
        gstAmount: booking.gstAmount,
        totalAmount: booking.totalAmount,
      },
    });
  } catch (error) {
    console.error("Razorpay order error:", error);
    return res.status(500).json({
      success: false,
      message: "Payment order failed",
    });
  }
};

// NOTE: Payment verification lives in controllers/paymentVerify.controller.js
// (mounted at POST /api/payment/verify via routes/payment.routes.js). Keeping
// two divergent verify implementations side-by-side was a real production bug
// — only one was reachable, and they differed on coupon redemption + socket
// emits. Single source of truth from here on.
