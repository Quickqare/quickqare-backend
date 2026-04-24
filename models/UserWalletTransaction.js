const mongoose = require("mongoose");

/* =====================================================
   USER WALLET TRANSACTION SCHEMA
   Used for user referral earnings
===================================================== */
const userWalletTransactionSchema = new mongoose.Schema(
  {
    /* =====================
       USER REFERENCE
    ===================== */
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
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
        "referral_reward",
        "adjustment",
      ],
      required: true,
    },

    /* =====================
       LINKED REFERRAL
    ===================== */
    referralId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Referral",
      default: null,
    },

    /* =====================
       TRANSACTION STATUS
    ===================== */
    status: {
      type: String,
      enum: ["pending", "success", "failed"],
      default: "success",
    },

    /* =====================
       CURRENCY
    ===================== */
    currency: {
      type: String,
      default: "INR",
    },

    /* =====================
       REFERENCE ID
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

module.exports = mongoose.model("UserWalletTransaction", userWalletTransactionSchema);