const Offer = require("../models/Offer");

exports.getOffers = async (req, res) => {
  try {
    const now = new Date();
    const offers = await Offer.find({
      isActive: true,
      $or: [{ startsAt: null }, { startsAt: { $lte: now } }],
      $and: [{ $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }],
    })
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    res.json({ success: true, offers });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch offers" });
  }
};
