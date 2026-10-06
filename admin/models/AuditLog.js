const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    actorAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      default: null,
      index: true,
    },
    action: { type: String, required: true, index: true },
    entityType: { type: String, default: "admin" },
    entityId: { type: String, default: null },
    requestId: { type: String, required: true, index: true },
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    beforeState: { type: String, default: null },
    afterState: { type: String, default: null },
    metadata: { type: String, default: null },
    // How the action went, filled in once the response is sent. null on
    // entries written before this was recorded.
    statusCode: { type: Number, default: null },
    outcome: { type: String, enum: ["success", "failed", null], default: null },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("AdminAuditLog", auditLogSchema, "admin_audit_logs");
