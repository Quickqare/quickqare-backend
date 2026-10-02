const mongoose = require("mongoose");

/* =====================================================
   PARTNER PAYOUT ACCOUNT
   Where a partner's withdrawals are sent: one bank account OR one UPI ID per
   partner. Kept out of the Partner document on purpose — several partner and
   admin endpoints return the whole Partner doc, and payout details must only
   leave the server through the dedicated payout-account endpoints.

   accountNumber / ifsc / upiId are stored encrypted (utils/fieldCrypto).

   Lifecycle: the partner submits → PENDING → an admin (payments.payout)
   checks the holder name against the partner and marks VERIFIED or REJECTED.
   Every resubmission bumps `revision` and resets to PENDING, so an admin can
   never verify details they haven't seen (verify is guarded on revision).
===================================================== */
const partnerPayoutAccountSchema = new mongoose.Schema(
  {
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Partner",
      required: true,
      unique: true,
      index: true,
    },

    method: {
      type: String,
      enum: ["BANK", "UPI"],
      required: true,
    },

    accountHolderName: { type: String, default: "", trim: true },

    // BANK
    accountNumber: { type: String, default: "" }, // encrypted
    ifsc: { type: String, default: "" }, // encrypted
    bankName: { type: String, default: "", trim: true },

    // UPI
    upiId: { type: String, default: "" }, // encrypted

    status: {
      type: String,
      enum: ["PENDING", "VERIFIED", "REJECTED"],
      default: "PENDING",
      index: true,
    },

    rejectionReason: { type: String, default: "" },

    // Incremented ($inc) on every partner submission, starting at 1; admin
    // verify must quote it. No default — it would clash with the upsert's $inc.
    revision: { type: Number },

    submittedAt: { type: Date, default: Date.now },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AdminUser", default: null },

    // Set when a partner REPLACES an existing account: withdrawals stay blocked
    // until then, so a hijacked login can't redirect earnings before the real
    // partner sees the "payout account changed" alert. null = no hold.
    withdrawalsBlockedUntil: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PartnerPayoutAccount", partnerPayoutAccountSchema);
