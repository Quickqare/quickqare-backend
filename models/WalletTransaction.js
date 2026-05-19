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

/* =====================
   IDEMPOTENCY GUARD
   At most one job_payment credit per { partner, booking }. creditWallet relies
   on this unique index so a concurrent double-complete fails at insert time
   instead of double-crediting the wallet. Partial filter keeps non-job_payment
   rows (bonus, adjustment, withdrawal) and null-booking rows unaffected.
===================== */
walletTransactionSchema.index(
  { partnerId: 1, bookingId: 1, reason: 1 },
  {
    unique: true,
    name: "uniq_job_payment_per_booking",
    partialFilterExpression: {
      reason: "job_payment",
      bookingId: { $type: "objectId" },
    },
  }
);

module.exports = mongoose.model(
  "WalletTransaction",
  walletTransactionSchema
);