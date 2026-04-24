const mongoose = require("mongoose");

/* =====================================================
   USER WALLET SCHEMA (FOR REFERRAL REWARDS)
===================================================== */
const userWalletSchema = new mongoose.Schema(
  {
    /* =====================
       USER REFERENCE
    ===================== */
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    /* =====================
       WALLET BALANCE
    ===================== */
    balance: {
      type: Number,
      default: 0,
      min: 0,
    },

    /* =====================
       TOTAL EARNINGS (FROM REFERRALS)
    ===================== */
    totalEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },

    /* =====================
       CURRENCY
    ===================== */
    currency: {
      type: String,
      default: "INR",
    },

    /* =====================
       WALLET LOCK
    ===================== */
    isLocked: {
      type: Boolean,
      default: false,
    },

    /* =====================
       LAST UPDATED
    ===================== */
    lastUpdated: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("UserWallet", userWalletSchema);