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
    // Number of wrong 2FA codes submitted against this challenge. Used to lock
    // the challenge after a few failures so a 6-digit code can't be brute-forced.
    twoFaAttempts: { type: Number, default: 0 },
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
