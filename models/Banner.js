const mongoose = require("mongoose");

const bannerSchema = new mongoose.Schema(
  {
    title: { type: String, default: "", trim: true },
    imageUrl: { type: String, required: true, trim: true },
    linkUrl: { type: String, default: "", trim: true },
    placement: { type: String, default: "home", index: true, trim: true },
    sortOrder: { type: Number, default: 0, index: true },
    displayDurationSeconds: { type: Number, default: 5 },
    isActive: { type: Boolean, default: true, index: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    createdByAdminId: { type: String, default: "", trim: true },
    updatedByAdminId: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Banner", bannerSchema);
