const Booking = require("../../models/Booking");
const Refund = require("../models/Refund");
const BookingTimeline = require("../models/BookingTimeline");

/*
 * The one place that records money owed back to a customer and marks it paid.
 *
 * The booking carries the running totals:
 *   refundAmount    everything recorded as refundable so far
 *   refundedAmount  the part of it already paid back
 *   refundStatus    PENDING while some of it is still owed
 * so "what to pay now" is always refundAmount − refundedAmount, and the total
 * can never pass what the customer actually paid.
 *
 * Before this, a booking refund, a dispute and a complaint each wrote their own
 * number with no limit: ₹99,999 could be "refunded" on an unpaid ₹500 booking,
 * and a dispute or complaint refund never reached the list finance pays from.
 */

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

// What the customer actually paid: the booking itself plus any paid on-site
// estimate. An unpaid booking owes nothing.
const AMOUNT_PAID = {
  $add: [
    { $cond: [{ $eq: ["$payment.status", "PAID"] }, { $ifNull: ["$totalAmount", 0] }, 0] },
    {
      $cond: [
        { $eq: ["$estimatePayment.status", "PAID"] },
        { $ifNull: ["$estimatePayment.totalAmount", 0] },
        0,
      ],
    },
  ],
};

// The running total already on record, whether still owed or paid back.
const REFUND_ON_RECORD = {
  $cond: [
    { $in: [{ $ifNull: ["$refundStatus", "NONE"] }, ["PENDING", "PROCESSED"]] },
    { $ifNull: ["$refundAmount", 0] },
    0,
  ],
};

// How much of that total has already been paid back, as it stands before a
// new amount is added: a refund marked PROCESSED went back in full, a PENDING
// one keeps what was settled before it, and a fresh record starts from nothing.
const PAID_BACK_SO_FAR = {
  $switch: {
    branches: [
      { case: { $eq: ["$refundStatus", "PROCESSED"] }, then: { $ifNull: ["$refundAmount", 0] } },
      { case: { $eq: ["$refundStatus", "PENDING"] }, then: { $ifNull: ["$refundedAmount", 0] } },
    ],
    default: 0,
  },
};

// $set fields that bring a booking's refund up to everything the customer
// paid — what an admin cancel owes them, since that is never the customer's
// doing. A booking that is unpaid, or already refunded in full, is left as is.
const OWED_MORE = { $gt: [AMOUNT_PAID, { $add: [REFUND_ON_RECORD, 0.005] }] };
const REFUND_ALL_PAID = {
  refundedAmount: { $cond: [OWED_MORE, PAID_BACK_SO_FAR, { $ifNull: ["$refundedAmount", 0] }] },
  refundAmount: { $cond: [OWED_MORE, AMOUNT_PAID, { $ifNull: ["$refundAmount", 0] }] },
  refundStatus: { $cond: [OWED_MORE, "PENDING", { $ifNull: ["$refundStatus", "NONE"] }] },
};

// The same two figures for a loaded booking, for the messages below.
const amountPaid = (booking) =>
  (booking.payment?.status === "PAID" ? Number(booking.totalAmount || 0) : 0) +
  (booking.estimatePayment?.status === "PAID" ? Number(booking.estimatePayment.totalAmount || 0) : 0);

const refundOnRecord = (booking) =>
  ["PENDING", "PROCESSED"].includes(booking.refundStatus) ? Number(booking.refundAmount || 0) : 0;

const refused = (status, code, message) => ({ error: { status, code, message } });

/**
 * Add `amountInr` to what a booking owes its customer.
 * Resolves to { refund, booking }, or { error: { status, code, message } }
 * when the amount is refused — nothing is written in that case.
 */
async function recordRefundOwed({ bookingId, amountInr, reason, adminId }) {
  const amount = round2(amountInr);
  const why = String(reason || "").trim();
  if (!Number.isFinite(amount) || amount < 1) {
    return refused(400, "VALIDATION_ERROR", "Refund amount must be at least ₹1");
  }
  if (!why) {
    return refused(400, "VALIDATION_ERROR", "A reason is required for a refund");
  }

  const booking = await Booking.findById(bookingId)
    .select("totalAmount payment.status estimatePayment.status estimatePayment.totalAmount refundAmount refundStatus")
    .lean();
  if (!booking) return refused(404, "NOT_FOUND", "Booking not found");

  const paid = round2(amountPaid(booking));
  const onRecord = round2(refundOnRecord(booking));
  if (paid <= 0) {
    return refused(400, "BOOKING_NOT_PAID", "This booking has no captured payment, so there is nothing to refund");
  }
  if (round2(onRecord + amount) > paid) {
    const left = round2(paid - onRecord);
    return refused(
      400,
      "REFUND_EXCEEDS_PAID",
      left > 0
        ? `The customer paid ₹${paid} and ₹${onRecord} is already refunded or owed, so at most ₹${left} more can be refunded`
        : `The customer paid ₹${paid} and all of it is already refunded or owed`
    );
  }

  // The same limit again inside the write, so two requests racing past the
  // check above can't add up to more than was paid. (+0.005: paise rounding.)
  const updated = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      $expr: { $lte: [{ $add: [REFUND_ON_RECORD, amount] }, { $add: [AMOUNT_PAID, 0.005] }] },
    },
    [
      {
        $set: {
          refundedAmount: PAID_BACK_SO_FAR,
          refundAmount: { $round: [{ $add: [REFUND_ON_RECORD, amount] }, 2] },
          refundStatus: "PENDING",
        },
      },
    ],
    { new: true }
  )
    .select("_id user refundAmount refundedAmount refundStatus")
    .lean();
  if (!updated) {
    return refused(409, "REFUND_CONFLICT", "Another refund was recorded for this booking just now. Reload and try again");
  }

  const refund = await Refund.create({
    bookingId,
    amountInr: amount,
    reason: why,
    status: "REQUESTED",
    requestedByAdminId: adminId,
  });
  await BookingTimeline.create({
    bookingId,
    eventType: "REFUND_REQUESTED",
    payload: JSON.stringify({ refundId: refund._id, amountInr: amount }),
    createdByAdminId: adminId,
  });

  return { refund, booking: updated };
}

/**
 * Mark everything a booking still owes as paid back.
 * Claim-first: only the call that flips PENDING → PROCESSED wins, so a double
 * click or two admins can't both record it. Resolves to null when the booking
 * has no pending refund.
 */
async function settleRefund({ bookingId, referenceId, adminId }) {
  const before = await Booking.findOneAndUpdate(
    { _id: bookingId, refundStatus: "PENDING" },
    [
      {
        $set: {
          refundStatus: "PROCESSED",
          refundProcessedAt: new Date(),
          refundedAmount: { $ifNull: ["$refundAmount", 0] },
          // $literal: admin-typed text must never be read as a "$field" path.
          ...(referenceId ? { "payment.razorpay_refund_id": { $literal: referenceId } } : {}),
        },
      },
    ]
  )
    .select("_id refundAmount refundedAmount")
    .lean();
  if (!before) return null;

  const settledAmount = Math.max(0, round2(Number(before.refundAmount || 0) - Number(before.refundedAmount || 0)));

  // A refund requested by hand has its own record — close it too, so the
  // booking and the Refund doc agree the money is back.
  await Refund.updateMany(
    { bookingId, status: "REQUESTED" },
    { $set: { status: "COMPLETED", processedAt: new Date() } }
  );
  await BookingTimeline.create({
    bookingId,
    eventType: "REFUND_COMPLETED",
    payload: JSON.stringify({ amountInr: settledAmount, referenceId: referenceId || null }),
    createdByAdminId: adminId,
  });

  return {
    bookingId: before._id,
    refundStatus: "PROCESSED",
    refundAmount: Number(before.refundAmount || 0),
    settledAmount,
  };
}

module.exports = { REFUND_ALL_PAID, recordRefundOwed, settleRefund, round2 };
