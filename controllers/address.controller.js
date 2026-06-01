const Address = require("../models/Address");

const VALID_LABELS = ["Home", "Work", "Hotel", "Other"];

exports.getAddresses = async (req, res) => {
  try {
    const addresses = await Address.find({ user: req.user._id })
      .sort({ isDefault: -1, createdAt: -1 })
      .lean();

    res.json({ success: true, addresses });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch addresses" });
  }
};

exports.saveAddress = async (req, res) => {
  try {
    const {
      label,
      address,
      pincode,
      latitude,
      longitude,
      city,
      area,
      houseDetails,
      landmark,
    } = req.body;

    if (!address || !pincode || !latitude || !longitude) {
      return res.status(400).json({ success: false, message: "address, pincode, latitude and longitude are required" });
    }

    const normalizedLabel = VALID_LABELS.includes(label) ? label : "Home";
    const lat = Number(latitude);
    const lng = Number(longitude);

    // Upsert: if the user already has an address at the same pincode within ~100m, update it
    const COORD_TOLERANCE = 0.001; // ~111 m per 0.001 degree
    const existing = await Address.findOne({
      user: req.user._id,
      pincode: String(pincode).trim(),
      latitude:  { $gte: lat - COORD_TOLERANCE, $lte: lat + COORD_TOLERANCE },
      longitude: { $gte: lng - COORD_TOLERANCE, $lte: lng + COORD_TOLERANCE },
    });

    if (existing) {
      const updated = await Address.findByIdAndUpdate(
        existing._id,
        {
          label: normalizedLabel,
          address: String(address).trim(),
          latitude: lat,
          longitude: lng,
          city:         city         ? String(city).trim()         : null,
          area:         area         ? String(area).trim()         : null,
          houseDetails: houseDetails ? String(houseDetails).trim() : null,
          landmark:     landmark     ? String(landmark).trim()     : null,
        },
        { new: true }
      );
      return res.status(200).json({ success: true, address: updated });
    }

    // No nearby duplicate — create new entry
    const existingCount = await Address.countDocuments({ user: req.user._id });
    const isDefault = existingCount === 0;

    const saved = await Address.create({
      user: req.user._id,
      label: normalizedLabel,
      address: String(address).trim(),
      pincode: String(pincode).trim(),
      latitude: lat,
      longitude: lng,
      city:         city         ? String(city).trim()         : null,
      area:         area         ? String(area).trim()         : null,
      houseDetails: houseDetails ? String(houseDetails).trim() : null,
      landmark:     landmark     ? String(landmark).trim()     : null,
      isDefault,
    });

    res.status(201).json({ success: true, address: saved });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to save address" });
  }
};

exports.updateAddress = async (req, res) => {
  try {
    const {
      label, address, pincode, latitude, longitude,
      city, area, houseDetails, landmark,
    } = req.body;

    if (!address || !pincode || !latitude || !longitude) {
      return res.status(400).json({ success: false, message: "address, pincode, latitude and longitude are required" });
    }

    const normalizedLabel = ["Home", "Work", "Hotel", "Other"].includes(label) ? label : "Home";

    const updated = await Address.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      {
        label: normalizedLabel,
        address:      String(address).trim(),
        pincode:      String(pincode).trim(),
        latitude:     Number(latitude),
        longitude:    Number(longitude),
        city:         city         ? String(city).trim()         : null,
        area:         area         ? String(area).trim()         : null,
        houseDetails: houseDetails ? String(houseDetails).trim() : null,
        landmark:     landmark     ? String(landmark).trim()     : null,
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: "Address not found" });
    }

    res.json({ success: true, address: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to update address" });
  }
};

exports.deleteAddress = async (req, res) => {
  try {
    const deleted = await Address.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!deleted) {
      return res.status(404).json({ success: false, message: "Address not found" });
    }

    // If we deleted the default, promote the newest remaining one
    if (deleted.isDefault) {
      const next = await Address.findOne({ user: req.user._id }).sort({ createdAt: -1 });
      if (next) await Address.findByIdAndUpdate(next._id, { isDefault: true });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to delete address" });
  }
};

exports.setDefaultAddress = async (req, res) => {
  try {
    await Address.updateMany({ user: req.user._id }, { isDefault: false });
    const updated = await Address.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { isDefault: true },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: "Address not found" });
    }

    res.json({ success: true, address: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to update default address" });
  }
};
