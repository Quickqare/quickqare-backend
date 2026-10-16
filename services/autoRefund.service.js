const Booking = require("../models/Booking");
const Refund = require("../admin/models/Refund");
const BookingTimeline = require("../admin/models/BookingTimeline");
const logger = require("../utils/logger");

/*
 * Pays a customer's refund back through Razorpay by itself.
 *
 * A booking with refundStatus PENDING owes the customer
 * refundAmount − refundedAmount. issueAutoRefund() sends that to Razorpay for
 * the booking's main payment and marks it PROCESSED once Razorpay accepted it.
 * Razorpay's webhook (refund.processed / refund.failed) then confirms or
 * reverses that — see handleRefundWebhook().
 *
 * Safety:
 *  - Claim first: only the call that sets the processing lease sends money, so
 *    a double trigger (cancel + cron) can't pay twice.
 *  - Before sending, the payment's refunds already on Razorpay are summed and
 *    only the shortfall is sent. A refund whose response or DB write was lost
 *    is adopted on the next try instead of being repeated; a refund finance
 *    already issued from the dashboard is counted too.
 *  - Never more than the booking's recorded refundAmount, which the refund
 *    service already caps at what the customer paid.
 *  - Bookings with an on-site estimate payment, with no payment id, or with a
 *    refund an admin has requested but not approved are left for a person.
 *  - AUTO_REFUND_DISABLED=true switches the whole thing off.
 */

const MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60 * 1000;
const SWEEP_BATCH = 25;

const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const toPaise = (inr) => Math.round(Number(inr || 0) * 100);

function isDisabled() {
  return String(process.env.AUTO_REFUND_DISABLED || "").toLowerCase() === "true";
}

function razorpayClient() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  const Razorpay = require("razorpay");
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

async function notifyCustomer(userId, status, bookingId, details) {
  try {
    const { notifyCustomerOfBookingStatus } = require("./pushNotification.service");
    await notifyCustomerOfBookingStatus(userId, status, bookingId, details);
  } catch (err) {
    logger.warn("[auto-refund] notify failed", { error: err.message });
  }
}

async function releaseClaim(bookingId, error) {
  await Booking.updateOne(
    { _id: bookingId },
    { $set: { refundProcessingAt: null, refundLastError: String(error || "").slice(0, 300) } }
  );
}

/**
 * Try to pay what a booking owes through Razorpay.
 * Resolves to { status, ... }: "processed" | "skipped" | "failed".
 */
async function issueAutoRefund(bookingId, { adminId = null } = {}) {
  if (isDisabled()) return { status: "skipped", reason: "disabled" };
  const razorpay = razorpayClient();
  if (!razorpay) return { status: "skipped", reason: "no_razorpay_keys" };

  const now = new Date();
  // Claim: PENDING, retries left, nobody else mid-flight, and nothing waiting
  // for an admin's approval.
  const awaitingApproval = await Refund.exists({ bookingId, status: "REQUESTED" });
  if (awaitingApproval && !adminId) return { status: "skipped", reason: "awaiting_admin_approval" };

  const claimed = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      refundStatus: "PENDING",
      "payment.status": "PAID",
      "payment.razorpay_payment_id": { $nin: [null, ""] },
      "estimatePayment.status": { $ne: "PAID" },
      // An admin pressing Approve may retry past the automatic attempt limit.
      ...(adminId ? {} : { refundAttempts: { $not: { $gte: MAX_ATTEMPTS } } }),
      $or: [{ refundProcessingAt: null }, { refundProcessingAt: { $lt: new Date(now.getTime() - LEASE_MS) } }],
    },
    adminId
      ? { $set: { refundProcessingAt: now, refundAttempts: 1 } }
      : { $set: { refundProcessingAt: now }, $inc: { refundAttempts: 1 } },
    { new: true }
  )
    .select("user payment.razorpay_payment_id totalAmount refundAmount refundedAmount refundAttempts")
    .lean();
  if (!claimed) return { status: "skipped", reason: "not_eligible" };

  const paymentId = claimed.payment.razorpay_payment_id;
  const targetPaise = toPaise(claimed.refundAmount);
  try {
    if (targetPaise <= 0 || targetPaise > toPaise(claimed.totalAmount)) {
      // Amount doesn't fit the main payment — a person decides.
      await releaseClaim(bookingId, "Refund amount does not fit the booking payment");
      await Booking.updateOne({ _id: bookingId }, { $set: { refundAttempts: MAX_ATTEMPTS } });
      return { status: "skipped", reason: "amount_mismatch" };
    }

    // What Razorpay already refunded on this payment (failed ones don't count).
    const existing = await razorpay.payments.fetchMultipleRefund(paymentId, { count: 100 });
    const items = (existing?.items || []).filter((r) => r.status !== "failed");
    const alreadyPaise = items.reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const sendPaise = targetPaise - alreadyPaise;

    let refundId;
    if (sendPaise > 0) {
      const created = await razorpay.payments.refund(paymentId, {
        amount: sendPaise,
        speed: "normal",
        receipt: `bk_${bookingId}_${claimed.refundAttempts}`.slice(0, 40),
        notes: { bookingId: String(bookingId), source: "auto_refund" },
      });
      refundId = created?.id;
    } else {
      // Already refunded on Razorpay (an earlier try whose write was lost, or a
      // dashboard refund): just record it.
      refundId = items[items.length - 1]?.id || null;
    }

    const done = await Booking.findOneAndUpdate(
      { _id: bookingId, refundStatus: "PENDING" },
      {
        $set: {
          refundStatus: "PROCESSED",
          refundProcessedAt: new Date(),
          refundedAmount: round2(claimed.refundAmount),
          refundProcessingAt: null,
          refundLastError: null,
          "payment.razorpay_refund_id": refundId || null,
        },
      },
      { new: true }
    )
      .select("user refundAmount")
      .lean();

    await Refund.updateMany(
      { bookingId, status: "REQUESTED" },
      { $set: { status: "COMPLETED", processedAt: new Date() } }
    );
    await BookingTimeline.create({
      bookingId,
      eventType: "REFUND_COMPLETED",
      payload: JSON.stringify({ amountInr: sendPaise > 0 ? sendPaise / 100 : 0, referenceId: refundId, auto: true }),
      ...(adminId ? { createdByAdminId: adminId } : {}),
    }).catch(() => {});

    if (done) {
      notifyCustomer(done.user, "REFUND_INITIATED", bookingId, { refundAmount: done.refundAmount });
    }
    logger.info("[auto-refund] refund sent", { bookingId: String(bookingId), refundId, sendPaise });
    return { status: "processed", refundId, amountInr: sendPaise / 100 };
  } catch (err) {
    const message = err?.error?.description || err?.message || "Razorpay refund failed";
    await releaseClaim(bookingId, message);
    logger.error("[auto-refund] refund failed — will retry or needs a person", {
      bookingId: String(bookingId),
      attempt: claimed.refundAttempts,
      error: message,
    });
    return { status: "failed", error: message };
  }
}

/**
 * Cron: pay every owed refund that nobody has sent yet (cancels by admin or the
 * system, payments captured for dead bookings, and any retry after a failure).
 */
async function sweepPendingRefunds() {
  if (isDisabled() || !razorpayClient()) return;
  const waiting = await Refund.distinct("bookingId", { status: "REQUESTED" });
  const rows = await Booking.find({
    refundStatus: "PENDING",
    "payment.status": "PAID",
    "payment.razorpay_payment_id": { $nin: [null, ""] },
    "estimatePayment.status": { $ne: "PAID" },
    refundAttempts: { $not: { $gte: MAX_ATTEMPTS } },
    _id: { $nin: waiting },
    $or: [{ refundProcessingAt: null }, { refundProcessingAt: { $lt: new Date(Date.now() - LEASE_MS) } }],
  })
    .select("_id")
    .sort({ updatedAt: 1 })
    .limit(SWEEP_BATCH)
    .lean();
  for (const row of rows) {
    await issueAutoRefund(row._id);
  }

  // Refunds that gave up need a person — say so loudly, once per sweep.
  const stuck = await Booking.countDocuments({
    refundStatus: "PENDING",
    refundAttempts: { $gte: MAX_ATTEMPTS },
  });
  if (stuck > 0) {
    logger.error("[auto-refund] refunds need manual handling in Payments → Customer Refunds", { count: stuck });
  }
}

/**
 * Razorpay refund.processed / refund.failed.
 *  processed → stamp the time and tell the customer it has been paid out.
 *  failed    → the money did not reach the customer: put the booking back to
 *              PENDING (no more auto retries — the bank/Razorpay rejected it)
 *              so it shows in the manual refunds list, and log it loudly.
 */
async function handleRefundWebhook(eventType, refund) {
  const paymentId = refund?.payment_id;
  if (!paymentId) return;
  const booking = await Booking.findOne({ "payment.razorpay_payment_id": paymentId })
    .select("_id user refundStatus refundedAmount refundAmount")
    .lean();
  if (!booking) return; // not a main booking payment (e.g. an estimate) — nothing to sync
  const amountInr = Number(refund.amount || 0) / 100;

  if (eventType === "refund.processed") {
    await BookingTimeline.create({
      bookingId: booking._id,
      eventType: "REFUND_COMPLETED",
      payload: JSON.stringify({ amountInr, referenceId: refund.id, confirmedByRazorpay: true }),
    }).catch(() => {});
    notifyCustomer(booking.user, "REFUND_PROCESSED", booking._id, { refundAmount: amountInr });
    return;
  }

  if (eventType === "refund.failed") {
    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          refundStatus: "PENDING",
          refundedAmount: Math.max(0, round2(Number(booking.refundedAmount || 0) - amountInr)),
          refundProcessedAt: null,
          refundProcessingAt: null,
          refundAttempts: MAX_ATTEMPTS, // stop auto retries; a person handles it
          refundLastError: `Razorpay refund ${refund.id} failed`,
        },
      }
    );
    await BookingTimeline.create({
      bookingId: booking._id,
      eventType: "REFUND_REQUESTED",
      payload: JSON.stringify({ amountInr, referenceId: refund.id, failed: true }),
    }).catch(() => {});
    logger.error("[rzp-webhook] REFUND FAILED — needs manual handling", {
      bookingId: String(booking._id),
      refundId: refund.id,
      amountInr,
    });
  }
}

module.exports = { issueAutoRefund, sweepPendingRefunds, handleRefundWebhook, MAX_ATTEMPTS };
