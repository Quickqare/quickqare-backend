const Booking = require("../models/Booking");
const { assignBooking } = require("./assignmentEngine");
const { buildDateTime } = require("./scheduling_service");
const { markSlotLockPaid } = require("./slotCapacity.service");
const { recordCouponRedemption } = require("./coupon.service");

/**
 * Finalize a booking whose payment is confirmed captured/PAID.
 *
 * This is the SINGLE source of truth for turning a paid booking into an
 * assignable one. It is called from two places:
 *   1. The client-driven verify endpoint (controllers/paymentVerify.controller)
 *   2. The Razorpay webhook (controllers/razorpayWebhook.controller)
 *
 * It is fully idempotent — the atomic `payment.status !== "PAID"` guard means
 * whichever path arrives first wins, and the loser is a no-op. Keeping both
 * paths on this one function prevents the divergent-implementation bug the
 * codebase has hit before.
 *
 * @param {object} booking  A loaded Booking mongoose document (already ownership/status checked by caller where relevant).
 * @param {object} payment  { razorpay_payment_id, razorpay_order_id, razorpay_signature }
 * @returns {Promise<{ outcome: "already_paid" | "queued" | "searching", booking: object }>}
 */
async function finalizePaidBooking(booking, payment = {}) {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = payment;

  const scheduledStart = booking.scheduledStartAt
    ? new Date(booking.scheduledStartAt)
    : buildDateTime(booking.scheduledDate, booking.scheduledTime);

  const hoursToService = (scheduledStart.getTime() - Date.now()) / (1000 * 60 * 60);

  // Customized (cake) orders are assigned IMMEDIATELY however far ahead they
  // are scheduled — never parked in QUEUED. The minLeadDays window exists so
  // the baker can bake; parking the order until the T-3h dispatch cron would
  // (a) give the baker 3 hours' notice for a made-to-order cake, (b) leave the
  // order partnerless so the per-baker daily cap can't count it — letting a
  // zone sell more cakes for a date than its bakers can make — and (c) starve
  // the day-before reminder cron, which only matches ASSIGNED+partner rows.
  // assignBooking's requireOnline default already relaxes to false for
  // non-imminent bookings, so the baker doesn't need to be online right now.
  const isCustomizedOrder = (booking.services || []).some((s) => s?.options?.flavour);
  const newStatus =
    hoursToService > 24 && !isCustomizedOrder ? "QUEUED" : "PENDING_ASSIGNMENT";

  // ATOMIC: only the first caller (client verify OR webhook) flips to PAID.
  const updatedBooking = await Booking.findOneAndUpdate(
    { _id: booking._id, "payment.status": { $ne: "PAID" } },
    {
      $set: {
        status: newStatus,
        ...(razorpay_payment_id ? { "payment.razorpay_payment_id": razorpay_payment_id } : {}),
        ...(razorpay_order_id ? { "payment.razorpay_order_id": razorpay_order_id } : {}),
        ...(razorpay_signature ? { "payment.razorpay_signature": razorpay_signature } : {}),
        "payment.status": "PAID",
      },
    },
    { new: true }
  );

  // Another path already finalized this booking — nothing to do.
  if (!updatedBooking) {
    return { outcome: "already_paid", booking };
  }

  await markSlotLockPaid(updatedBooking._id);
  updatedBooking.lockedUntil = null;
  updatedBooking.slotReservationExpiresAt = null;
  await updatedBooking.save();

  // Record coupon redemption. Fail-soft: a tracking error must never undo a
  // successful payment.
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
        "[payment-finalize] recordCouponRedemption failed (non-fatal):",
        couponErr.message
      );
    }
  }

  // Notify the customer so the app flips off PENDING_PAYMENT immediately.
  if (global.io) {
    global.io.to(`user_${updatedBooking.user}`).emit("booking_update", {
      bookingId: updatedBooking._id.toString(),
      status: newStatus === "QUEUED" ? "QUEUED" : "SEARCHING",
      paymentConfirmed: true,
    });
  }

  if (newStatus === "QUEUED") {
    return { outcome: "queued", booking: updatedBooking };
  }

  // Surface SEARCHING before assignBooking flips it to ASSIGNING_LOCK → ASSIGNED.
  await Booking.updateOne(
    { _id: updatedBooking._id, status: "PENDING_ASSIGNMENT" },
    { $set: { status: "SEARCHING" } }
  );

  await assignBooking(updatedBooking._id);

  return { outcome: "searching", booking: updatedBooking };
}

module.exports = { finalizePaidBooking };
