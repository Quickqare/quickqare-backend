const mongoose = require("mongoose");

/* =====================================================
   PARTNER WALLET SCHEMA (PRODUCTION READY)
===================================================== */
const partnerWalletSchema = new mongoose.Schema(
  {
    /* =====================
       PARTNER REFERENCE
    ===================== */
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Partner",
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

    withdrawableBalance: {
      type: Number,
      default: 0,
      min: 0,
    },

    pendingBalance: {
      type: Number,
      default: 0,
      min: 0,
    },

    /* =====================
       TOTAL EARNINGS
    ===================== */
    totalEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },

    /* =====================
       TOTAL WITHDRAWN
    ===================== */
    totalWithdrawn: {
      type: Number,
      default: 0,
      min: 0,
    },

    /* =====================
       CURRENCY (FUTURE READY)
    ===================== */
    currency: {
      type: String,
      default: "INR",
    },

    /* =====================
       WALLET LOCK
       (admin control / audit / fraud prevention)
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

module.exports = mongoose.model("PartnerWallet", partnerWalletSchema);
