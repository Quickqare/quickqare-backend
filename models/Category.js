const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    slug: {
      type: String,
      lowercase: true,
      trim: true,
      index: true,
    },
    imageUrl: String,
    webImageUrl: String,
    /* Explicit behaviour class for assignment/booking logic. Detection by
       name/slug substring ("mehendi", "cake", "ac"...) still works as the
       fallback, but it breaks silently when a category is renamed — set this
       and the rename becomes safe. GENERAL (the default) adds no signal;
       the string fallback still applies, so existing data is unaffected.
         AC          → skill-tier gate, 45-min buffer, 360-min daily cap
         MEHENDI     → specialization gate, hands package pricing
         CELEBRATION → baker daily cap, advance-only lead time */
    categoryType: {
      type: String,
      enum: ["GENERAL", "AC", "MEHENDI", "CELEBRATION"],
      default: "GENERAL",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Category", categorySchema);
