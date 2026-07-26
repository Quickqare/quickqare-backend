const mongoose = require("mongoose");

/**
 * A phone number left by a prospective service partner on the public
 * "Register as a Professional" web page. Ops calls them back — this is a
 * callback queue, not an account (no auth, no partner record created here).
 */
const professionalLeadSchema = new mongoose.Schema(
  {
    name: { type: String, default: "", trim: true, maxlength: 100 },
    phone: { type: String, required: true, trim: true, maxlength: 15, index: true },
    source: { type: String, default: "web", trim: true },
    status: {
      type: String,
      enum: ["NEW", "CONTACTED", "CONVERTED", "REJECTED"],
      default: "NEW",
      index: true,
    },
    notes: { type: String, default: "", trim: true, maxlength: 1000 },
    contactedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AdminUser", default: null },
    contactedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ProfessionalLead", professionalLeadSchema);
