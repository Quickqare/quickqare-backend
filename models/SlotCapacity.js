const mongoose = require("mongoose");

const slotCapacitySchema = new mongoose.Schema(
  {
    slotKey: { type: String, required: true, unique: true, index: true },
    pincode: { type: String, required: true, index: true },
    dateKey: { type: String, required: true, index: true },
    time: { type: String, required: true, index: true },
    totalUnits: { type: Number, required: true, default: 0, min: 0 },
    reservedUnits: { type: Number, required: true, default: 0, min: 0 },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SlotCapacity", slotCapacitySchema);
