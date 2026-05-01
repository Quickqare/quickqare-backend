const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      default: "User",
    },

    gender: {
      type: String,
      default: "",
    },

    phone: {
      type: String,
      required: true,
      unique: true,
    },

    email: {
      type: String,
      default: "",
    },

    status: {
      type: String,
      enum: ["ACTIVE", "BLOCKED"],
      default: "ACTIVE",
      index: true,
    },

    // 🔐 OTP-only authentication — never returned in default queries
    otp: {
      type: String,
      select: false,
    },
    otpExpiresAt: {
      type: Date,
      select: false,
    },

    fcmToken: {
      type: String,
      default: "",
    },

    // Referral system
    referralCode: {
      type: String,
      unique: true,
      sparse: true, // Allow null values but unique when present
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    hasCompletedFirstBooking: {
      type: Boolean,
      default: false,
    },

    // Profile edit tracking (3 times per year limit)
    profileEdits: [{
      date: {
        type: Date,
        default: Date.now,
      },
      changes: {
        type: Object,
        default: {},
      },
    }],
  }, { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
