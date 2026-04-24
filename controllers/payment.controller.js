const Razorpay = require("razorpay");
const crypto = require("crypto");
const Booking = require("../models/Booking");
const { assignBooking } = require("../services/assignmentEngine");
const { recordCouponRedemption } = require("../services/coupon.service");

/* =====================================================
   CREATE RAZORPAY ORDER
   (UPDATED FOR MULTI-SERVICE BOOKINGS)
===================================================== */
exports.createOrder = async (req, res) => {
  try {
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

    /* =====================
       CREATE RAZORPAY ORDER
    ===================== */
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const order = await razorpay.orders.create({
      amount: booking.totalAmount * 100, // convert to paise
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
      order,
      booking,
      pricing: {
        baseAmount: booking.baseAmount,
        discountAmount: booking.discountAmount,
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

/* =====================================================
   VERIFY PAYMENT + AUTO ASSIGN PARTNER
===================================================== */
exports.verifyPayment = async (req, res) => {
  try {
    const {
      bookingId,
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
    } = req.body;

    if (
      !bookingId ||
      !razorpay_payment_id ||
      !razorpay_order_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing payment details",
      });
    }

    const booking = await Booking.findById(bookingId);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    /* =====================
       VERIFY SIGNATURE
    ===================== */
    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      booking.payment.status = "FAILED";
      await booking.save();

      return res.status(400).json({
        success: false,
        message: "Payment verification failed",
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

    if (booking.couponId && booking.couponCode) {
      await recordCouponRedemption({
        couponId: booking.couponId,
        bookingId: booking._id,
        customerId: booking.user,
        discountAmountInr: booking.discountAmount || booking.couponDiscountAmount || 0,
      });
    }

    /* =====================
       AUTO ASSIGN PARTNER
    ===================== */
    await assignBooking(booking._id);

    return res.json({
      success: true,
      message: "Payment verified. Searching for partner.",
    });
  } catch (error) {
    console.error("Payment verification error:", error);
    return res.status(500).json({
      success: false,
      message: "Payment verification failed",
    });
  }
};
