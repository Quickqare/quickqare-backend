const mongoose = require("mongoose");

const bookingTimelineSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    eventType: {
      type: String,
      enum: [
        "CREATED",
        "ASSIGNED",
        "REASSIGNED",
        "STARTED",
        "COMPLETED",
        "CANCELLED",
        // Written by the admin force-cancel / request-reschedule routes. They
        // were missing here, so both routes answered 500 AFTER changing the
        // booking — the admin saw "failed" for an action that had gone through.
        "FORCE_CANCELLED",
        "RESCHEDULE_REQUESTED",
        "REFUND_REQUESTED",
        "REFUND_COMPLETED",
        "DISPUTE_OPENED",
        "DISPUTE_RESOLVED",
        // Partner reliability signals + team alerts (services/opsAlert.service)
        "PARTNER_SEEN",
        "PARTNER_NOT_SEEN",
        "PARTNER_LATE",
        "PARTNER_NO_SHOW",
        "PARTNER_PAUSED",
        "START_CODE_RESET",
        // Security-audit alerts: a booking's start code locked after repeated
        // wrong codes, and a partner closing a booking as the customer's fault
        // (no refund) — both raised to ops for review.
        "START_CODE_LOCKED",
        "CUSTOMER_FAULT_CLOSED",
      ],
      required: true,
      index: true,
    },
    payload: { type: String, default: "{}" },
    createdByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BookingTimeline", bookingTimelineSchema, "booking_timeline");
