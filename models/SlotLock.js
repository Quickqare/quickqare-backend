const mongoose = require("mongoose");

const slotLockSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      unique: true,
      index: true,
    },
    bookingNumber: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    pincode: {
      type: String,
      required: true,
      index: true,
    },
    dateKey: {
      type: String,
      required: true,
      index: true,
    },
    slotKeys: {
      type: [String],
      default: [],
      index: true,
    },
    units: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    status: {
      type: String,
      enum: ["PENDING_PAYMENT", "PAID", "RELEASED"],
      default: "PENDING_PAYMENT",
      index: true,
    },
    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    releasedAt: {
      type: Date,
      default: null,
    },
    releaseReason: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SlotLock", slotLockSchema);
