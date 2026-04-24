const mongoose = require("mongoose");

const complaintTimelineSchema = new mongoose.Schema(
  {
    complaintId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Complaint",
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ["SUBMITTED", "UNDER_REVIEW", "IN_PROGRESS", "RESOLVED", "CLOSED"],
    },
    previousStatus: {
      type: String,
      enum: ["SUBMITTED", "UNDER_REVIEW", "IN_PROGRESS", "RESOLVED", "CLOSED"],
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser", // For admin updates, null for user submissions
      default: null,
    },
    notes: {
      type: String,
      default: "",
    },
    isVisibleToUser: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Index for efficient queries
complaintTimelineSchema.index({ complaintId: 1, createdAt: -1 });

module.exports = mongoose.model("ComplaintTimeline", complaintTimelineSchema);