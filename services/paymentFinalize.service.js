const Booking = require("../models/Booking");
const logger = require("../utils/logger");
const { assignBooking } = require("./assignmentEngine");
const { buildDateTime } = require("./scheduling_service");
const { markSlotLockPaid } = require("./slotCapacity.service");
const { recordCouponRedemption } = require("./coupon.service");

/**
 * Finalize a paid guest mehendi add-on (origin === "partner_onspot").
 *
 * These bookings never go through the assignment engine: the partner is already
 * on-site and pre-assigned, so a confirmed payment activates the job directly
 * (→ IN_PROGRESS) and tells the artist to start. Shared by the customer verify
 * endpoint (controllers/guestAddon.controller) and the Razorpay webhook — the
 * webhook previously ran the scheduled-booking finalize on these, stranding a
 * PAID add-on in SEARCHING with no partner notification.
 *
 * Idempotent via the same `payment.status !== "PAID"` guard as
 * finalizePaidBooking; whichever path lands first wins.
 *
 * @returns {Promise<{ outcome: "already_paid" | "in_progress" | "not_payable", booking: object }>}
 */
async function finalizePaidGuestAddon(booking, payment = {}) {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = payment;

  const updated = await Booking.findOneAndUpdate(
    {
      _id: booking._id,
      "payment.status": { $ne: "PAID" },
      status: { $nin: ["CANCELLED", "COMPLETED"] },
    },
    {
      $set: {
        status: "IN_PROGRESS",
        inProgressAt: new Date(),
        ...(razorpay_payment_id ? { "payment.razorpay_payment_id": razorpay_payment_id } : {}),
        ...(razorpay_order_id ? { "payment.razorpay_order_id": razorpay_order_id } : {}),
        ...(razorpay_signature ? { "payment.razorpay_signature": razorpay_signature } : {}),
        "payment.status": "PAID",
      },
    },
    { new: true }
  );

  if (!updated) {
    const fresh = await Booking.findById(booking._id).select("status payment").lean();
    if (fresh?.payment?.status === "PAID") {
      return { outcome: "already_paid", booking };
    }
    // Declined/cancelled before the payment landed — the caller must flag the
    // captured money for refund, never reactivate the add-on.
    return { outcome: "not_payable", booking: fresh || booking };
  }

  if (global.io) {
    if (updated.partner) {
      global.io.to(`partner_${updated.partner}`).emit("guest_addon_approved", {
        bookingId: updated._id.toString(),
        parentBookingId: updated.parentBooking ? updated.parentBooking.toString() : null,
      });
    }
    global.io.to(`user_${updated.user}`).emit("booking_update", {
      bookingId: updated._id.toString(),
      status: "IN_PROGRESS",
      paymentConfirmed: true,
    });
  }

  return { outcome: "in_progress", booking: updated };
}

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
 * The update is also guarded on the booking NOT being CANCELLED/COMPLETED: a
 * booking cancelled between the caller's read and this write (user cancel,
 * expiry cron) must never be resurrected into an assignable state whose slot
 * reservation is already released. That case returns outcome "not_payable" and
 * the caller is responsible for flagging the captured money for refund.
 *
 * @param {object} booking  A loaded Booking mongoose document (already ownership/status checked by caller where relevant).
 * @param {object} payment  { razorpay_payment_id, razorpay_order_id, razorpay_signature }
 * @returns {Promise<{ outcome: "already_paid" | "queued" | "searching" | "in_progress" | "not_payable", booking: object }>}
 */
async function finalizePaidBooking(booking, payment = {}) {
  // Guest add-ons have their own activation path (pre-assigned partner already
  // on-site → straight to IN_PROGRESS, no slot lock, no assignment engine).
  if (booking.origin === "partner_onspot") {
    return finalizePaidGuestAddon(booking, payment);
  }

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

  // ATOMIC: only the first caller (client verify OR webhook) flips to PAID, and
  // only while the booking is still alive (see doc comment above).
  const updatedBooking = await Booking.findOneAndUpdate(
    {
      _id: booking._id,
      "payment.status": { $ne: "PAID" },
      status: { $nin: ["CANCELLED", "COMPLETED"] },
    },
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

  if (!updatedBooking) {
    const fresh = await Booking.findById(booking._id).select("status payment").lean();
    if (fresh?.payment?.status === "PAID") {
      // Another path already finalized this booking — nothing to do.
      return { outcome: "already_paid", booking };
    }
    // Booking died (cancelled) between the caller's read and this write — the
    // captured money must be refunded, not resurrected into a booking whose
    // slot reservation is gone.
    return { outcome: "not_payable", booking: fresh || booking };
  }

  await markSlotLockPaid(updatedBooking._id);
  // Targeted update (not a full-doc save) so a concurrent writer can't be
  // clobbered by stale in-memory state.
  await Booking.updateOne(
    { _id: updatedBooking._id },
    { $set: { lockedUntil: null, slotReservationExpiresAt: null } }
  );
  updatedBooking.lockedUntil = null;
  updatedBooking.slotReservationExpiresAt = null;

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
      // A customer who already paid must keep their booking regardless — so this
      // stays fail-soft. But an over-the-limit redemption means the discount was
      // granted beyond the coupon's budget (the in-flight guard in
      // validateCouponForAmount should make this rare): log it at error with a
      // stable tag so ops can alert/reconcile, distinct from a generic tracking
      // failure.
      const isLimitOverrun = couponErr?.statusCode === 400;
      logger.error("[payment-finalize] recordCouponRedemption failed (non-fatal)", {
        tag: isLimitOverrun ? "COUPON_BUDGET_OVERRUN" : "COUPON_TRACKING_ERROR",
        bookingId: updatedBooking._id.toString(),
        couponId: String(updatedBooking.couponId),
        couponCode: updatedBooking.couponCode,
        discountInr:
          updatedBooking.discountAmount ||
          updatedBooking.couponDiscountAmount ||
          0,
        error: couponErr.message,
      });
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

module.exports = { finalizePaidBooking, finalizePaidGuestAddon };
