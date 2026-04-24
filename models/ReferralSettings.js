const mongoose = require("mongoose");

const referralSettingsSchema = new mongoose.Schema(
  {
    // Reward for referrer (wallet credit in rupees)
    referrerRewardAmount: {
      type: Number,
      required: true,
      default: 50,
      min: 0,
    },

    // Discount for new user (coupon value in rupees)
    newUserDiscountAmount: {
      type: Number,
      required: true,
      default: 100,
      min: 0,
    },

    // Minimum order amount for referral to be valid
    minOrderAmount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    // Expiry days for referral coupon
    couponExpiryDays: {
      type: Number,
      required: true,
      default: 30,
      min: 1,
    },

    // Maximum referrals per user
    maxReferralsPerUser: {
      type: Number,
      required: true,
      default: 10,
      min: 1,
    },

    // Whether referral system is enabled
    isEnabled: {
      type: Boolean,
      default: true,
    },

    // Description for the referral coupon
    couponDescription: {
      type: String,
      default: "Referral discount for new users",
    },
  },
  { timestamps: true }
);

// Ensure only one settings document exists
referralSettingsSchema.pre("save", async function (next) {
  if (this.isNew) {
    const existing = await this.constructor.findOne();
    if (existing) {
      const error = new Error("Only one referral settings document is allowed");
      return next(error);
    }
  }
  next();
});

module.exports = mongoose.model("ReferralSettings", referralSettingsSchema);