const mongoose = require("mongoose");

// Customer / partner JWTs handed back at logout. A JWT stays cryptographically
// valid until it expires (90 days by default), so signing out has to record it
// here for the auth middlewares to refuse it. Only a SHA-256 of the token is
// stored, never the token itself. Each row is removed by the TTL index once the
// token would have expired anyway, so the collection never grows unbounded.
const revokedTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

revokedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RevokedToken", revokedTokenSchema);
