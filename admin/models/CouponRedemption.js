const mongoose = require("mongoose");

const couponRedemptionSchema = new mongoose.Schema(
  {
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      required: true,
      index: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    discountAmountInr: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CouponRedemption", couponRedemptionSchema, "coupon_redemptions");
