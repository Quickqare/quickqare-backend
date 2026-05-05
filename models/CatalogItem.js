const mongoose = require("mongoose");

const catalogItemSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true },
    priceInr:    { type: Number, required: true, min: 0 },
    unit:        { type: String, default: "piece" },
    description: { type: String, default: "" },
    isActive:    { type: Boolean, default: true },
    sortOrder:   { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CatalogItem", catalogItemSchema);
