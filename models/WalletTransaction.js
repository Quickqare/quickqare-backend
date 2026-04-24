const mongoose = require("mongoose");

/* =====================================================
   WALLET TRANSACTION SCHEMA (PRODUCTION READY)
   Used for partner earnings / withdrawals / penalties
===================================================== */
const walletTransactionSchema = new mongoose.Schema(
  {
    /* =====================
       PARTNER REFERENCE
    ===================== */
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Partner",
      required: true,
      index: true,
    },

    /* =====================
       AMOUNT
    ===================== */
    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    /* =====================
       CREDIT / DEBIT
    ===================== */
    type: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
    },

    /* =====================
       TRANSACTION REASON
    ===================== */
    reason: {
      type: String,
      enum: [
        "job_payment",
        "penalty",
        "cancellation",
        "bonus",
        "withdrawal",
        "adjustment",
      ],
      required: true,
    },

    /* =====================
       LINKED BOOKING
    ===================== */
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },

    /* =====================
       TRANSACTION STATUS
       (important for payouts)
    ===================== */
    status: {
      type: String,
      enum: ["pending", "success", "failed"],
      default: "success",
    },

    /* =====================
       CURRENCY (FUTURE READY)
    ===================== */
    currency: {
      type: String,
      default: "INR",
    },

    /* =====================
       REFERENCE ID
       (payment gateway / audit)
    ===================== */
    referenceId: {
      type: String,
      default: null,
    },

    /* =====================
       DESCRIPTION
    ===================== */
    description: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

/* =====================
   PERFORMANCE INDEXES
===================== */
walletTransactionSchema.index({ partnerId: 1, createdAt: -1 });

module.exports = mongoose.model(
  "WalletTransaction",
  walletTransactionSchema
);