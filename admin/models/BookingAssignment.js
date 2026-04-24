const mongoose = require("mongoose");

const bookingAssignmentSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Partner",
      required: true,
      index: true,
    },
    assignedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      required: true,
      index: true,
    },
    reason: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BookingAssignment", bookingAssignmentSchema, "booking_assignments");
