const Rating = require("../models/Rating");
const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");

exports.submitRating = async (req, res) => {
  try {
    // partnerId / serviceId are NEVER taken from the client — they are derived
    // from the booking below, so a caller can't attribute a rating to an
    // arbitrary partner/service they didn't actually book.
    const { bookingId, rating, tags, reviewText } = req.body;
    const customerId = req.user.id;

    if (!bookingId || rating === undefined || rating === null) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const ratingValue = Number(rating);
    if (!Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
      return res.status(400).json({ success: false, message: "rating must be between 1 and 5" });
    }

    // Ownership + eligibility: the booking must belong to the caller and be
    // completed. This is the IDOR gate — without it any user could rate any
    // booking and skew any partner's/service's aggregate score.
    const booking = await Booking.findOne({ _id: bookingId, user: customerId })
      .select("partner primaryService serviceId services status")
      .lean();

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    if (booking.status !== "COMPLETED") {
      return res.status(400).json({ success: false, message: "Only completed bookings can be rated" });
    }

    // Derive the rated entities from the booking, not the request body.
    const partnerId = booking.partner || null;
    const serviceId =
      booking.primaryService ||
      booking.serviceId ||
      booking.services?.[0]?.serviceId ||
      null;

    // Prevent duplicate ratings
    const existing = await Rating.findOne({ bookingId });
    if (existing) {
      return res.status(400).json({ success: false, message: "Already rated this service" });
    }

    const newRating = new Rating({
      bookingId,
      serviceId,
      partnerId,
      customerId,
      rating: ratingValue,
      tags,
      reviewText,
    });
    await newRating.save();

    // Calculate weighted average for Partner
    if (partnerId) {
      const partner = await Partner.findById(partnerId);
      if (partner) {
        const totalReviews = partner.totalReviews || 0;
        const oldAvg = partner.rating || 0;
        const newAvg = (oldAvg * totalReviews + ratingValue) / (totalReviews + 1);

        partner.rating = parseFloat(newAvg.toFixed(2));
        partner.totalReviews = totalReviews + 1;
        await partner.save();
      }
    }

    // Calculate weighted average for Service
    if (serviceId) {
      const service = await Service.findById(serviceId);
      if (service) {
        const totalReviews = service.totalReviews || 0;
        const oldAvg = service.rating || 0;
        const newAvg = (oldAvg * totalReviews + ratingValue) / (totalReviews + 1);

        service.rating = parseFloat(newAvg.toFixed(2));
        service.totalReviews = totalReviews + 1;
        await service.save();
      }
    }

    res.status(201).json({ success: true, message: "Rating submitted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getPendingRating = async (req, res) => {
  try {
    const userId = req.user.id;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const recentBookings = await Booking.find({
      $or: [{ userId }, { user: userId }],
      status: "COMPLETED",
      updatedAt: { $gte: twentyFourHoursAgo },
    }).sort({ updatedAt: -1 });

    for (let booking of recentBookings) {
      const hasRated = await Rating.findOne({ bookingId: booking._id });
      if (!hasRated) {
        return res.json({ success: true, pending: true, booking });
      }
    }

    res.json({ success: true, pending: false });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
