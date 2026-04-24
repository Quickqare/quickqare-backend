const mongoose = require("mongoose");

const disputeEventSchema = new mongoose.Schema(
  {
    eventType: { type: String, required: true },
    payload: { type: String, default: "{}" },
    createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "AdminUser", default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const disputeEvidenceSchema = new mongoose.Schema(
  {
    type: { type: String, default: "TEXT" },
    url: { type: String, default: "" },
    notes: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const disputeSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Partner",
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ["OPEN", "IN_REVIEW", "RESOLVED"],
      default: "OPEN",
      index: true,
    },
    issueType: { type: String, default: "GENERAL" },
    description: { type: String, default: "" },
    resolution: {
      type: String,
      enum: ["REFUND", "PENALTY", "NO_ACTION", null],
      default: null,
    },
    resolvedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      default: null,
    },
    resolvedAt: { type: Date, default: null },
    events: { type: [disputeEventSchema], default: [] },
    evidence: { type: [disputeEvidenceSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Dispute", disputeSchema, "disputes");
