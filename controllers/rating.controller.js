const Rating = require("../models/Rating");
const Booking = require("../models/Booking");
const { refreshPartnerRating, refreshServiceRating } = require("../services/rating.service");

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

    // Recompute the partner's and service's averages from their ratings. The
    // rating itself is already stored, so a failure here is logged instead of
    // failing the request — the next rating recomputes the summary anyway.
    await Promise.all([refreshPartnerRating(partnerId), refreshServiceRating(serviceId)]).catch(
      (err) => console.error("Rating summary refresh failed:", err)
    );

    res.status(201).json({ success: true, message: "Rating submitted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getPendingRating = async (req, res) => {
  try {
    const userId = req.user.id;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Only what the rating prompt shows and posts back. The whole booking carries
    // the assignment audit (candidate partners, scores), the partners' private
    // on-site reports, the job-spot selfie and the start code — none of which a
    // customer's phone should receive, and this endpoint used to send them all.
    // (Other customer-facing booking reads strip these; see
    // sanitizeBookingForCustomer. A whitelist can't leak a field added later.)
    const recentBookings = await Booking.find({
      $or: [{ userId }, { user: userId }],
      status: "COMPLETED",
      updatedAt: { $gte: twentyFourHoursAgo },
    })
      .select("services.name services.serviceId serviceCategory scheduledDate scheduledTime")
      .sort({ updatedAt: -1 })
      .lean();

    if (!recentBookings.length) {
      return res.json({ success: true, pending: false });
    }

    const rated = await Rating.find({ bookingId: { $in: recentBookings.map((b) => b._id) } })
      .select("bookingId")
      .lean();
    const ratedIds = new Set(rated.map((r) => String(r.bookingId)));

    const booking = recentBookings.find((b) => !ratedIds.has(String(b._id)));
    if (booking) {
      return res.json({ success: true, pending: true, booking });
    }

    res.json({ success: true, pending: false });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
