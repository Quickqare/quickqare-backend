const mongoose = require("mongoose");

const referralSchema = new mongoose.Schema(
  {
    referrerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    referredId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["PENDING", "COMPLETED", "EXPIRED", "INVALID"],
      default: "PENDING",
      index: true,
    },

    // Track if reward has been given
    rewardGiven: {
      type: Boolean,
      default: false,
    },

    // Coupon created for the referred user
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      default: null,
    },

    // Amount credited to referrer's wallet
    referrerRewardAmount: {
      type: Number,
      default: 0,
    },

    // When the referral was completed (first booking)
    completedAt: {
      type: Date,
      default: null,
    },

    // Notes for admin
    notes: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// Compound index to prevent duplicate referrals
referralSchema.index({ referrerId: 1, referredId: 1 }, { unique: true });

// Prevent self-referral
referralSchema.pre("save", function (next) {
  if (this.referrerId.equals(this.referredId)) {
    const error = new Error("Users cannot refer themselves");
    return next(error);
  }
  next();
});

module.exports = mongoose.model("Referral", referralSchema);