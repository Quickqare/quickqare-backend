const mongoose = require("mongoose");

const offerSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["bundle", "coupon", "info"],
      required: true,
    },
    title: { type: String, required: true, trim: true },
    tagline: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },
    badgeText: { type: String, trim: true, default: "" },   // "HOT" | "NEW" | "LIMITED" | ""
    badgeColor: { type: String, trim: true, default: "#DC2626" },

    // bundle fields
    serviceCategory: { type: String, trim: true, default: null },
    originalPrice: { type: Number, default: null },
    bundlePrice: { type: Number, default: null },

    // coupon fields
    couponCode: { type: String, trim: true, uppercase: true, default: null },

    // If populated, offer is shown/relevant only for these specific services
    applicableServices: [
      { type: mongoose.Schema.Types.ObjectId, ref: "Service" },
    ],

    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Offer", offerSchema);
