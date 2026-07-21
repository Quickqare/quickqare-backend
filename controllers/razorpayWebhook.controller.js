const crypto = require("crypto");
const Booking = require("../models/Booking");
const { finalizePaidBooking } = require("../services/paymentFinalize.service");
const logger = require("../utils/logger");

/**
 * =====================================================
 * RAZORPAY WEBHOOK  →  POST /api/payment/webhook
 * =====================================================
 * Server-to-server source of truth for payment state. The client-driven
 * /verify endpoint can be lost (app crash, network drop) AFTER Razorpay has
 * already captured the money — leaving a customer charged with no confirmed
 * booking. This webhook reconciles that independently of the client.
 *
 * Mounted with a RAW body parser (see routes) because signature verification
 * must run over the exact bytes Razorpay sent — express.json() would re-serialize
 * and break the HMAC.
 *
 * Configure in Razorpay Dashboard → Webhooks:
 *   URL:    https://api.quickqare.in/api/payment/webhook
 *   Secret: RAZORPAY_WEBHOOK_SECRET (env)
 *   Events: payment.captured, payment.failed
 */
exports.handleRazorpayWebhook = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      logger.error("[rzp-webhook] RAZORPAY_WEBHOOK_SECRET not configured");
      // 500 so Razorpay retries once we've configured the secret.
      return res.status(500).json({ success: false });
    }

    const signature = req.headers["x-razorpay-signature"];
    if (!signature) {
      return res.status(400).json({ success: false, message: "Missing signature" });
    }

    // req.body is a Buffer here (raw parser). Verify over the exact bytes.
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    // timingSafeEqual guards against signature-comparison timing attacks.
    const sigBuf = Buffer.from(String(signature));
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      logger.warn("[rzp-webhook] Invalid signature — rejected");
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }

    // ACK Razorpay immediately. All processing below is best-effort and idempotent;
    // holding the response open risks Razorpay timing out and retry-storming.
    res.json({ success: true });

    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch (parseErr) {
      logger.error("[rzp-webhook] Body parse failed", { error: parseErr.message });
      return;
    }

    const eventType = event?.event;
    const paymentEntity = event?.payload?.payment?.entity;

    if (eventType === "payment.captured" && paymentEntity) {
      await handlePaymentCaptured(paymentEntity);
    } else if (eventType === "payment.failed" && paymentEntity) {
      await handlePaymentFailed(paymentEntity);
    }
    // Other events are acknowledged and ignored.
  } catch (error) {
    logger.error("[rzp-webhook] handler error", { error: error.message, stack: error.stack });
    // Response may already be sent; nothing else to do.
  }
};

/**
 * payment.captured — money is in. Find the booking by order id and finalize it.
 * If the booking is no longer payable (cancelled / slot expired) we have taken
 * money for a dead booking → flag it for refund instead of silently dropping it.
 */
async function handlePaymentCaptured(payment) {
  const orderId = payment.order_id;
  if (!orderId) return;

  const booking = await Booking.findOne({ "payment.razorpay_order_id": orderId });
  if (!booking) {
    // Not a booking payment — it may be an on-site estimate payment, which
    // rides the same Razorpay account but settles into estimatePayment.
    const estimateHandled = await handleEstimatePaymentCaptured(payment);
    if (!estimateHandled) {
      logger.error("[rzp-webhook] payment.captured for unknown order", { orderId, paymentId: payment.id });
    }
    return;
  }

  // Already finalized by the client verify path — idempotent no-op.
  if (booking.payment?.status === "PAID") {
    return;
  }

  // Booking is dead but money was captured → needs a refund. Do NOT assign.
  if (["CANCELLED", "COMPLETED"].includes(booking.status)) {
    await Booking.updateOne(
      { _id: booking._id, refundStatus: { $in: ["NONE", null] } },
      {
        $set: {
          "payment.razorpay_payment_id": payment.id,
          refundStatus: "PENDING",
          refundAmount: Number(payment.amount || 0) / 100, // paise → INR
        },
      }
    );
    logger.error("[rzp-webhook] Captured payment for non-payable booking — flagged for refund", {
      bookingId: booking._id.toString(),
      status: booking.status,
      orderId,
      paymentId: payment.id,
    });
    return;
  }

  // Healthy path: booking still awaiting payment → finalize (idempotent).
  try {
    const { outcome } = await finalizePaidBooking(booking, {
      razorpay_payment_id: payment.id,
      razorpay_order_id: orderId,
    });

    // Booking was cancelled between our status read above and the finalize
    // write (user cancel / expiry cron) — same "dead booking, money captured"
    // situation as the early check, so flag it for refund the same way.
    if (outcome === "not_payable") {
      await Booking.updateOne(
        { _id: booking._id, "payment.status": { $ne: "PAID" }, refundStatus: { $in: ["NONE", null] } },
        {
          $set: {
            "payment.razorpay_payment_id": payment.id,
            refundStatus: "PENDING",
            refundAmount: Number(payment.amount || 0) / 100, // paise → INR
          },
        }
      );
      logger.error("[rzp-webhook] Captured payment lost the finalize race to a cancel — flagged for refund", {
        bookingId: booking._id.toString(),
        orderId,
        paymentId: payment.id,
      });
      return;
    }

    logger.info("[rzp-webhook] payment.captured finalized", {
      bookingId: booking._id.toString(),
      outcome,
    });
  } catch (err) {
    logger.error("[rzp-webhook] finalize failed", {
      bookingId: booking._id.toString(),
      error: err.message,
    });
  }
}

/**
 * payment.captured for an on-site estimate order — mark the booking's
 * estimatePayment PAID (idempotent) and tell the on-site partner. Returns true
 * when the order id matched an estimate payment.
 */
async function handleEstimatePaymentCaptured(payment) {
  const orderId = payment.order_id;
  const booking = await Booking.findOne({ "estimatePayment.razorpay_order_id": orderId })
    .select("_id partner estimatePayment")
    .lean();
  if (!booking) return false;

  const updated = await Booking.findOneAndUpdate(
    { _id: booking._id, "estimatePayment.status": { $ne: "PAID" } },
    {
      $set: {
        "estimatePayment.status": "PAID",
        "estimatePayment.razorpay_payment_id": payment.id,
        "estimatePayment.paidAt": new Date(),
      },
    },
    { new: true }
  );

  if (updated && global.io && updated.partner) {
    global.io.to(`partner_${updated.partner}`).emit("estimate_paid", {
      bookingId: updated._id.toString(),
    });
  }

  logger.info("[rzp-webhook] estimate payment.captured recorded", {
    bookingId: booking._id.toString(),
    orderId,
    alreadyPaid: !updated,
  });
  return true;
}

/**
 * payment.failed — mark the booking's payment FAILED if it is still pending.
 * Never touches an already-PAID booking.
 */
async function handlePaymentFailed(payment) {
  const orderId = payment.order_id;
  if (!orderId) return;

  await Booking.updateOne(
    { "payment.razorpay_order_id": orderId, "payment.status": "PENDING" },
    { $set: { "payment.status": "FAILED" } }
  );
  // Estimate orders live in estimatePayment — same never-touch-PAID rule.
  await Booking.updateOne(
    { "estimatePayment.razorpay_order_id": orderId, "estimatePayment.status": "PENDING" },
    { $set: { "estimatePayment.status": "FAILED" } }
  );
  logger.info("[rzp-webhook] payment.failed recorded", { orderId, paymentId: payment.id });
}
