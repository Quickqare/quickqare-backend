const mongoose = require("mongoose");

const addressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    label: {
      type: String,
      // "Hotel" is offered by the app and accepted by the controller; without it
      // here, saving a new Hotel address failed validation (and the app, which
      // ignores that call's result, never said so).
      enum: ["Home", "Work", "Hotel", "Other"],
      default: "Home",
    },
    address: {
      type: String,
      required: true,
      trim: true,
    },
    pincode: {
      type: String,
      required: true,
      trim: true,
    },
    latitude: {
      type: Number,
      required: true,
    },
    longitude: {
      type: Number,
      required: true,
    },
    city: {
      type: String,
      trim: true,
      default: null,
    },
    area: {
      type: String,
      trim: true,
      default: null,
    },
    houseDetails: {
      type: String,
      trim: true,
      default: null,
    },
    landmark: {
      type: String,
      trim: true,
      default: null,
    },
    // Who to ask for at this address ("Who will receive the service?" in the app):
    // the customer, or someone else such as a parent. Both set, or both null.
    receiverName: {
      type: String,
      trim: true,
      default: null,
    },
    receiverPhone: {
      type: String,
      trim: true,
      default: null,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Address", addressSchema);
