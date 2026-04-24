const mongoose = require("mongoose");

const adminSettingSchema = new mongoose.Schema(
  {
    partnerSubscriptionRequired: {
      type: Boolean,
      default: false,
    },
    partnerVerificationRequired: {
      type: Boolean,
      default: false,
    },
    partnerSelfieRequired: {
      type: Boolean,
      default: false,
    },
    updatedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminSetting", adminSettingSchema);
