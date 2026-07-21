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
       Prevent double verification. Runs before the order-binding check below so
       an already-settled booking short-circuits to success regardless of what
       order id is (re)submitted.
    ===================== */
    if (booking.payment?.status === "PAID") {
      return res.json({
        success: true,
        message: "Payment already verified",
        bookingId: booking._id,
      });
    }

    /* =====================
       ORDER BINDING
       The signature below only proves that (order_id | payment_id) is a genuine
       pair from our Razorpay account — it does NOT prove the payment belongs to
       THIS booking. Without this check, a user could pay a cheap booking's order
       and submit that valid triple against an expensive booking (pay ₹49, mark a
       ₹5000 booking PAID). Require that the submitted order matches the order we
       created and stored for this booking at order-creation time. This is a pure
       rejection with no state mutation, placed before the lock-expiry handling
       below (which cancels the booking) so a mismatched order can't cancel it.
    ===================== */
    const expectedOrderId = booking.payment?.razorpay_order_id;
    if (!expectedOrderId || String(razorpay_order_id) !== String(expectedOrderId)) {
      return res.status(400).json({
        success: false,
        message: "Payment does not match this booking",
      });
    }

    /* =====================
       VERIFY SIGNATURE FIRST
       The signature proves Razorpay captured this payment against our stored
       order. It must be checked BEFORE any state-mutating branch below: the
       expired-lock and cancelled-booking branches behave completely differently
       depending on whether real money was captured, and the old order (cancel
       first, verify later) left a charged customer with no refund flag.
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

    // timingSafeEqual guards against signature-comparison timing attacks
    // (mirrors the Razorpay webhook handler). Only equal-length buffers can be
    // compared — timingSafeEqual throws on a length mismatch — so a forged
    // signature of the wrong length is treated as invalid here.
    const expectedBuf = Buffer.from(expectedSignature);
    const providedBuf = Buffer.from(String(razorpay_signature));
    const signatureValid =
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf);

    if (!signatureValid) {
      // Only tear down a booking that is still awaiting payment — never mutate
      // a booking that has moved on. Release clears the slot fields itself; the
      // guarded update can't overwrite a concurrent PAID finalize.
      if (booking.status === "PENDING_PAYMENT") {
        await releaseSlotCapacityByBookingId(booking._id, {
          releaseReason: "payment_signature_failed",
        });
        await Booking.updateOne(
          { _id: booking._id, "payment.status": { $ne: "PAID" } },
          { $set: { "payment.status": "FAILED" } }
        );
      }

      return res.status(400).json({
        success: false,
        message: "Invalid payment signature",
      });
    }

    /* =====================
       SIGNATURE VALID = MONEY CAPTURED
       From here on, every non-success path must leave the captured money
       flagged for refund — silently dropping it strands the customer's payment.
    ===================== */

    // Booking no longer payable (cancelled by the user or the expiry cron while
    // the checkout was open) → queue a full refund, never resurrect it.
    if (booking.status !== "PENDING_PAYMENT") {
      await Booking.updateOne(
        { _id: booking._id, "payment.status": { $ne: "PAID" }, refundStatus: { $in: ["NONE", null] } },
        {
          $set: {
            "payment.razorpay_payment_id": razorpay_payment_id,
            refundStatus: "PENDING",
            refundAmount: Number(booking.totalAmount || 0),
          },
        }
      );
      return res.status(409).json({
        success: false,
        message: "This booking is no longer active. Your payment will be refunded in full.",
      });
    }

    // Slot hold lapsed before the payment landed. The reservation may already be
    // released, so the booking can't proceed — cancel it (guarded so a concurrent
    // webhook finalize wins) and queue a full refund of the captured amount.
    // Guest add-ons never hold a slot lock, so they skip this check entirely.
    if (
      booking.origin !== "partner_onspot" &&
      (!booking.lockedUntil || new Date(booking.lockedUntil).getTime() <= Date.now())
    ) {
      const cancelled = await Booking.findOneAndUpdate(
        { _id: booking._id, status: "PENDING_PAYMENT", "payment.status": { $ne: "PAID" } },
        {
          $set: {
            status: "CANCELLED",
            cancelledBy: "system",
            cancelledAt: new Date(),
            cancelReason: "Payment received after slot lock expired",
            "payment.razorpay_payment_id": razorpay_payment_id,
            refundStatus: "PENDING",
            refundAmount: Number(booking.totalAmount || 0),
          },
        },
        { new: true }
      );

      if (!cancelled) {
        // The webhook finalized this payment concurrently — the booking is live.
        const fresh = await Booking.findById(booking._id).select("payment.status").lean();
        if (fresh?.payment?.status === "PAID") {
          return res.json({
            success: true,
            message: "Payment already verified",
            bookingId: booking._id,
          });
        }
        return res.status(409).json({
          success: false,
          message: "This booking is no longer active. Your payment will be refunded in full.",
        });
      }

      await releaseSlotCapacityByBookingId(booking._id, {
        releaseReason: "payment_after_lock_expiry",
      });

      return res.status(409).json({
        success: false,
        message: "Selected slot is no longer available. Your payment will be refunded in full.",
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

    // Cancelled between our read and the finalize write — flag the refund.
    if (outcome === "not_payable") {
      await Booking.updateOne(
        { _id: booking._id, "payment.status": { $ne: "PAID" }, refundStatus: { $in: ["NONE", null] } },
        {
          $set: {
            "payment.razorpay_payment_id": razorpay_payment_id,
            refundStatus: "PENDING",
            refundAmount: Number(booking.totalAmount || 0),
          },
        }
      );
      return res.status(409).json({
        success: false,
        message: "This booking is no longer active. Your payment will be refunded in full.",
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
