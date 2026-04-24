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
        "REFUND_REQUESTED",
        "REFUND_COMPLETED",
        "DISPUTE_OPENED",
        "DISPUTE_RESOLVED",
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
