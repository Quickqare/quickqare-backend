const mongoose = require("mongoose");

const JobSchema = new mongoose.Schema({
  service: String,
  lat: Number,
  lng: Number,
  price: Number,

  status: {
    type: String,
    enum: ["SEARCHING", "ASSIGNED", "CANCELLED"],
    default: "SEARCHING",
  },

  assignedTo: {
    type: String,
    default: null,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Job", JobSchema);
