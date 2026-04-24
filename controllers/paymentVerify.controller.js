const crypto = require("crypto");
const Booking = require("../models/Booking");
const { assignBooking } = require("../services/assignmentEngine");

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

    /* =====================
       VERIFY SIGNATURE
    ===================== */
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      booking.payment.status = "FAILED";
      await booking.save();

      return res.status(400).json({
        success: false,
        message: "Invalid payment signature",
      });
    }

    /* =====================
       MARK PAYMENT SUCCESS
    ===================== */
    booking.payment.razorpay_payment_id = razorpay_payment_id;
    booking.payment.razorpay_order_id = razorpay_order_id;
    booking.payment.razorpay_signature = razorpay_signature;
    booking.payment.status = "PAID";

    booking.status = "SEARCHING";

    await booking.save();

    /* =====================
       AUTO ASSIGN PARTNER
    ===================== */
    await assignBooking(booking._id);

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