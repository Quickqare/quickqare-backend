const mongoose = require("mongoose");

const adminSessionSchema = new mongoose.Schema(
  {
    adminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      required: true,
      index: true,
    },
    refreshTokenHash: { type: String, default: null, select: false },
    twoFaCodeHash: { type: String, default: null, select: false },
    challengeExpiresAt: { type: Date, default: null, index: true },
    refreshExpiresAt: { type: Date, default: null, index: true },
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    isRevoked: { type: Boolean, default: false, index: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminSession", adminSessionSchema);
