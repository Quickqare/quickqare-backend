const Offer = require("../../models/Offer");

const VALID_TYPES = ["bundle", "coupon", "info"];

exports.getOffers = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Number(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const [offers, total] = await Promise.all([
      Offer.find().sort({ sortOrder: 1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Offer.countDocuments(),
    ]);

    res.json({ success: true, data: offers, meta: { total, page, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch offers" });
  }
};

exports.createOffer = async (req, res) => {
  try {
    const {
      type, title, tagline, description, badgeText, badgeColor,
      serviceCategory, originalPrice, bundlePrice,
      couponCode, applicableServices, sortOrder, isActive, startsAt, endsAt,
    } = req.body;

    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: "type must be bundle, coupon, or info" });
    }
    if (!title?.trim()) {
      return res.status(400).json({ success: false, message: "title is required" });
    }

    const offer = await Offer.create({
      type,
      title: title.trim(),
      tagline: tagline?.trim() || "",
      description: description?.trim() || "",
      badgeText: badgeText?.trim() || "",
      badgeColor: badgeColor?.trim() || "#DC2626",
      serviceCategory: serviceCategory?.trim() || null,
      originalPrice: originalPrice != null ? Number(originalPrice) : null,
      bundlePrice: bundlePrice != null ? Number(bundlePrice) : null,
      couponCode: couponCode?.trim().toUpperCase() || null,
      applicableServices: Array.isArray(applicableServices) ? applicableServices : [],
      sortOrder: Number(sortOrder) || 0,
      isActive: isActive !== false,
      startsAt: startsAt ? new Date(startsAt) : null,
      endsAt: endsAt ? new Date(endsAt) : null,
    });

    res.status(201).json({ success: true, offer });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to create offer" });
  }
};

exports.updateOffer = async (req, res) => {
  try {
    const {
      type, title, tagline, description, badgeText, badgeColor,
      serviceCategory, originalPrice, bundlePrice,
      couponCode, applicableServices, sortOrder, isActive, startsAt, endsAt,
    } = req.body;

    if (type && !VALID_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: "Invalid type" });
    }

    const update = {};
    if (type !== undefined) update.type = type;
    if (title !== undefined) update.title = title.trim();
    if (tagline !== undefined) update.tagline = tagline.trim();
    if (description !== undefined) update.description = description.trim();
    if (badgeText !== undefined) update.badgeText = badgeText.trim();
    if (badgeColor !== undefined) update.badgeColor = badgeColor.trim();
    if (serviceCategory !== undefined) update.serviceCategory = serviceCategory?.trim() || null;
    if (originalPrice !== undefined) update.originalPrice = originalPrice != null ? Number(originalPrice) : null;
    if (bundlePrice !== undefined) update.bundlePrice = bundlePrice != null ? Number(bundlePrice) : null;
    if (couponCode !== undefined) update.couponCode = couponCode?.trim().toUpperCase() || null;
    if (applicableServices !== undefined) update.applicableServices = Array.isArray(applicableServices) ? applicableServices : [];
    if (sortOrder !== undefined) update.sortOrder = Number(sortOrder);
    if (isActive !== undefined) update.isActive = Boolean(isActive);
    if (startsAt !== undefined) update.startsAt = startsAt ? new Date(startsAt) : null;
    if (endsAt !== undefined) update.endsAt = endsAt ? new Date(endsAt) : null;

    const offer = await Offer.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!offer) return res.status(404).json({ success: false, message: "Offer not found" });

    res.json({ success: true, offer });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to update offer" });
  }
};

exports.deleteOffer = async (req, res) => {
  try {
    const deleted = await Offer.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: "Offer not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to delete offer" });
  }
};
