const mongoose = require("mongoose");
const { isValidCell } = require("../utils/h3");

/* =====================================================
   HUB SCHEMA  (Urban-Company-style service zone)
   A named service area defined as a set of H3 cells.
   Partners are assigned to exactly one hub; bookings
   match a hub when the booking's H3 cell is one of the
   hub's cells.
===================================================== */
const hubSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    // The set of H3 cells (res 7) that make up this hub's shape.
    // Admin "draws" the hub by selecting adjacent cells on the map.
    h3Cells: {
      type: [String],
      default: [],
      index: true,
      validate: {
        validator: (cells) =>
          Array.isArray(cells) && cells.every((c) => isValidCell(c)),
        message: "h3Cells must all be valid H3 cell indices",
      },
    },

    resolution: { type: Number, default: 7 },

    // Hub centre — the "H" marker shown on the map. Derived from the
    // centroid of the selected cells, or set explicitly by admin.
    center: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },

    isActive:           { type: Boolean, default: true, index: true },
    customerAppEnabled: { type: Boolean, default: true },
    partnerAppEnabled:  { type: Boolean, default: true },

    // Each hub serves exactly ONE service category. Hubs of *different*
    // categories may overlap the same H3 cells (e.g. an AC hub and a Mehendi
    // hub covering the same area); two hubs of the *same* category may not.
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
      index: true,
    },
    // Denormalised category name, kept in sync on save for display/filtering
    // without a populate on every list.
    categoryName: { type: String, default: "" },

    city:  { type: String, default: "" },
    state: { type: String, default: "" },
  },
  { timestamps: true }
);

// Cell-conflict checks always filter by category + cells, so index both.
hubSchema.index({ category: 1, h3Cells: 1 });

module.exports = mongoose.model("Hub", hubSchema);
