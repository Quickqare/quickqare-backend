const mongoose = require("mongoose");

const complaintSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    issueType: {
      type: String,
      required: true,
      enum: [
        "SERVICE_NOT_COMPLETED",
        "SERVICE_DELAYED",
        "SERVICE_QUALITY_ISSUE",
        "PARTNER_BEHAVIOR",
        "PAYMENT_ISSUE",
        "APP_TECHNICAL_ISSUE",
        "OTHER"
      ],
    },
    description: {
      type: String,
      required: true,
      maxlength: 1000,
    },
    images: [{
      type: String, // Cloudinary URLs
      default: [],
    }],
    status: {
      type: String,
      required: true,
      enum: ["SUBMITTED", "UNDER_REVIEW", "IN_PROGRESS", "RESOLVED", "CLOSED"],
      default: "SUBMITTED",
    },
    resolution: {
      type: String,
      default: "",
    },
    refundAmount: {
      type: Number,
      default: 0,
    },
    reServiceScheduled: {
      type: Boolean,
      default: false,
    },
    adminNotes: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// Index for efficient queries
complaintSchema.index({ orderId: 1, userId: 1 });
complaintSchema.index({ status: 1 });
complaintSchema.index({ userId: 1 });

module.exports = mongoose.model("Complaint", complaintSchema);