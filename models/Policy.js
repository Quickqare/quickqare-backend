const mongoose = require("mongoose");

/**
 * Simple CMS-style policy page used by mobile + admin.
 * `type` examples: "privacy", "terms", "refund", etc.
 */
const PolicySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    title: { type: String, default: "" },
    content: { type: String, default: "" },
    lastUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AdminUser", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Policy", PolicySchema);

