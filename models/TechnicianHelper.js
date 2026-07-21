const mongoose = require("mongoose");

/* =====================================================
   TECHNICIAN ↔ HELPER RELATIONSHIP
   Helpers assist AC technicians with installation /
   uninstallation manpower. A technician invites a helper
   by phone; the helper accepts; only an admin can unlink.

   A helper belongs to ONE technician at a time. The
   partial unique index below enforces this at the DB
   level — a helper can have at most one ACTIVE row.
===================================================== */
const technicianHelperSchema = new mongoose.Schema(
  {
    technician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Partner",
      required: true,
      index: true,
    },

    helper: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Partner",
      required: true,
      // No field-level index here: the partial-unique index on { helper: 1 }
      // (status: ACTIVE) defined below already covers helper lookups. Declaring
      // both produced a duplicate-{helper:1}-index warning at boot.
    },

    // Phone number the technician typed when inviting (audit trail).
    invitePhone: {
      type: String,
      default: "",
      trim: true,
    },

    status: {
      type: String,
      enum: ["PENDING", "ACTIVE", "REJECTED", "REMOVED"],
      default: "PENDING",
      index: true,
    },

    invitedAt: {
      type: Date,
      default: Date.now,
    },

    respondedAt: {
      type: Date,
      default: null,
    },

    // Set by the reminder cron once a nudge for a still-pending invite is sent.
    reminderSentAt: {
      type: Date,
      default: null,
    },

    // Set only by an admin unlink / reassign.
    removedAt: {
      type: Date,
      default: null,
    },

    removedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      default: null,
    },
  },
  { timestamps: true }
);

/* One row per technician-helper pair — re-invites reuse the existing row. */
technicianHelperSchema.index({ technician: 1, helper: 1 }, { unique: true });

/* A helper can have at most ONE ACTIVE technician (admin-controlled). */
technicianHelperSchema.index(
  { helper: 1 },
  { unique: true, partialFilterExpression: { status: "ACTIVE" } }
);

module.exports = mongoose.model("TechnicianHelper", technicianHelperSchema);
