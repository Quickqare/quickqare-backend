const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const PartnerWallet = require("../models/PartnerWallet");

/* =====================================================
   1. PLATFORM OVERVIEW
===================================================== */
exports.getOverview = async (req, res) => {
  try {
    // total bookings
    const totalBookings = await Booking.countDocuments();

    // total revenue from completed bookings
    const revenueResult = await Booking.aggregate([
      { $match: { status: "COMPLETED" } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$totalAmount" },
        },
      },
    ]);

    const totalRevenue = revenueResult[0]?.totalRevenue || 0;

    res.json({
      success: true,
      data: {
        totalBookings,
        totalRevenue,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* =====================================================
   2. TODAY STATS
===================================================== */
exports.getTodayStats = async (req, res) => {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const bookingsToday = await Booking.countDocuments({
      createdAt: { $gte: start, $lte: end },
    });

    const completedToday = await Booking.countDocuments({
      createdAt: { $gte: start, $lte: end },
      status: "COMPLETED",
    });

    const revenueResult = await Booking.aggregate([
      {
        $match: {
          createdAt: { $gte: start, $lte: end },
          status: "COMPLETED",
        },
      },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$totalAmount" },
        },
      },
    ]);

    const revenueToday = revenueResult[0]?.revenue || 0;

    res.json({
      success: true,
      data: {
        bookingsToday,
        completedToday,
        revenueToday,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* =====================================================
   3. BOOKING STATUS DISTRIBUTION
===================================================== */
exports.getBookingStatusStats = async (req, res) => {
  try {
    const stats = await Booking.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          status: "$_id",
          count: 1,
          _id: 0,
        },
      },
    ]);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* =====================================================
   4. PARTNER PERFORMANCE (OPTIMIZED)
===================================================== */
exports.getPartnerPerformance = async (req, res) => {
  try {
    const partners = await Partner.find().select(
      "name phone plan activeJobs"
    );

    const results = [];

    for (const partner of partners) {
      const [totalJobs, completedJobs, cancelledJobs, wallet] =
        await Promise.all([
          Booking.countDocuments({ partner: partner._id }),
          Booking.countDocuments({
            partner: partner._id,
            status: "COMPLETED",
          }),
          Booking.countDocuments({
            partner: partner._id,
            cancelledBy: "partner",
          }),
          PartnerWallet.findOne({ partnerId: partner._id }),
        ]);

      results.push({
        partnerId: partner._id,
        name: partner.name,
        phone: partner.phone,
        plan: partner.plan,
        activeJobs: partner.activeJobs || 0,
        totalJobs,
        completedJobs,
        cancelledJobs,
        earnings: wallet?.totalEarnings || 0,
      });
    }

    res.json({
      success: true,
      data: results,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
