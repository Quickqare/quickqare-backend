const mongoose = require("mongoose");

const refundSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    amountInr: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["REQUESTED", "COMPLETED", "FAILED"],
      default: "REQUESTED",
      index: true,
    },
    requestedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      required: true,
    },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Refund", refundSchema, "refunds");
