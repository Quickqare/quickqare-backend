const mongoose = require("mongoose");

const RatingSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, unique: true, index: true },
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", default: null, index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", default: null, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    rating: { type: Number, required: true, min: 1, max: 5 },
    tags: [{ type: String }],
    reviewText: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Rating", RatingSchema);

