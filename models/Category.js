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
         AC          → skill-tier gate, 45-min buffer, technician team packing
         MEHENDI     → specialization gate, hands package pricing
         CELEBRATION → none (cakes discontinued; kept so existing rows stay valid)
         SALON       → skill-tier gate, 240-min visit-window team split */
    categoryType: {
      type: String,
      enum: ["GENERAL", "AC", "MEHENDI", "CELEBRATION", "SALON"],
      default: "GENERAL",
    },
    /* Who may deliver this category's services. FEMALE / MALE limit
       assignment, slot listing and admin manual assignment to partners whose
       registered gender matches (e.g. "Salon for Women" → FEMALE); a partner
       with no gender on file never matches. ANY (the default) adds no
       restriction. Admin-set only — never inferred from the name. */
    partnerGender: {
      type: String,
      enum: ["ANY", "FEMALE", "MALE"],
      default: "ANY",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Category", categorySchema);
