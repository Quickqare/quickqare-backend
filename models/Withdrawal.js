const mongoose = require("mongoose");

/* =====================================================
   WITHDRAWAL SCHEMA (PRODUCTION READY)
   Partner payout requests
===================================================== */
const withdrawalSchema = new mongoose.Schema(
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
       WITHDRAWAL AMOUNT
    ===================== */
    amount: {
      type: Number,
      required: true,
      min: 1,
    },

    /* =====================
       STATUS
    ===================== */
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
      index: true,
    },

    /* =====================
       BALANCE HELD
       true  → the amount was atomically reserved out of the partner's
               withdrawable balance when the request was created. Approve must
               NOT debit again; reject must refund the held amount.
       false → legacy request created before the hold model; approve debits at
               approval time, reject is a no-op on the balance.
    ===================== */
    balanceHeld: {
      type: Boolean,
      default: false,
    },

    /* =====================
       BANK DETAILS SNAPSHOT
       (freeze at request time)
    ===================== */
    bankDetails: {
      accountHolderName: String,
      accountNumber: String,
      ifsc: String,
      bankName: String,
    },

    /* =====================
       ADMIN PROCESSING
    ===================== */
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },

    processedAt: {
      type: Date,
      default: null,
    },

    /* =====================
       REJECTION REASON
    ===================== */
    reason: {
      type: String,
      default: "",
    },

    /* =====================
       PAYMENT REFERENCE
       (bank transfer id / UTR / gateway id)
    ===================== */
    referenceId: {
      type: String,
      default: null,
    },

    /* =====================
       CURRENCY (FUTURE READY)
    ===================== */
    currency: {
      type: String,
      default: "INR",
    },
  },
  { timestamps: true }
);

/* =====================
   PERFORMANCE INDEXES
===================== */
withdrawalSchema.index({ partnerId: 1, createdAt: -1 });

module.exports = mongoose.model("Withdrawal", withdrawalSchema);