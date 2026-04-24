const mongoose = require("mongoose");

const payoutItemSchema = new mongoose.Schema(
  {
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Partner",
      required: true,
      index: true,
    },
    amountInr: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["PENDING", "PROCESSED", "FAILED"],
      default: "PENDING",
      index: true,
    },
    referenceId: { type: String, default: "" },
  },
  { _id: false }
);

const payoutBatchSchema = new mongoose.Schema(
  {
    createdByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      required: true,
      index: true,
    },
    totalAmountInr: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["PENDING", "COMPLETED", "FAILED"],
      default: "PENDING",
      index: true,
    },
    items: { type: [payoutItemSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PayoutBatch", payoutBatchSchema, "payout_batches");
