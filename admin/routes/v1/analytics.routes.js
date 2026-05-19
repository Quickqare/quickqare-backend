const express = require("express");
const Booking = require("../../../models/Booking");
const Partner = require("../../../models/Partner");
const User = require("../../../models/User");
const Rating = require("../../../models/Rating");
const PartnerWallet = require("../../../models/PartnerWallet");
const Complaint = require("../../../models/Complaint");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const { PERMISSIONS } = require("../../constants/permissions");
const { success, fail } = require("../../utils/response");

const router = express.Router();
router.use(authenticateAdmin, authorize(PERMISSIONS.ANALYTICS_READ));

function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

function clampDays(val, min = 7, max = 90, def = 30) {
  const n = parseInt(val) || def;
  return Math.min(Math.max(n, min), max);
}

// ─── EXISTING ──────────────────────────────────────────────────────────────

router.get("/revenue-by-city", async (req, res) => {
  try {
    const rows = await Booking.aggregate([
      { $match: { "payment.status": "PAID" } },
      { $group: { _id: "$pincode", totalRevenue: { $sum: "$totalAmount" }, bookings: { $sum: 1 } } },
      { $sort: { totalRevenue: -1 } },
      { $limit: 100 },
    ]);
    return success(res, rows, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "ANALYTICS_CITY_FAILED", "Unable to fetch revenue by city", error.message, { requestId: req.requestId });
  }
});

router.get("/service-mix", async (req, res) => {
  try {
    const rows = await Booking.aggregate([
      {
        $project: {
          category: {
            $ifNull: [
              "$serviceCategory",
              { $ifNull: [{ $arrayElemAt: ["$services.category", 0] }, "unknown"] },
            ],
          },
        },
      },
      { $group: { _id: "$category", bookings: { $sum: 1 } } },
      { $sort: { bookings: -1 } },
    ]);
    return success(res, rows, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "ANALYTICS_SERVICE_FAILED", "Unable to fetch service mix", error.message, { requestId: req.requestId });
  }
});

router.get("/peak-hours", async (req, res) => {
  try {
    const rows = await Booking.aggregate([
      { $group: { _id: "$scheduledTime", bookings: { $sum: 1 } } },
      { $sort: { bookings: -1 } },
      { $limit: 24 },
    ]);
    return success(res, rows, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "ANALYTICS_PEAK_HOURS_FAILED", "Unable to fetch peak hours", error.message, { requestId: req.requestId });
  }
});

// ─── CUSTOMER ANALYTICS ────────────────────────────────────────────────────

router.get("/customer-overview", async (req, res) => {
  try {
    const ninetyDaysAgo = daysAgo(90);

    const [totalCustomers, repeatData, ltvData, activeUserIds] = await Promise.all([
      User.countDocuments({}),
      Booking.aggregate([
        { $match: { "payment.status": "PAID" } },
        { $group: { _id: "$user", count: { $sum: 1 } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            repeaters: { $sum: { $cond: [{ $gt: ["$count", 1] }, 1, 0] } },
          },
        },
      ]),
      Booking.aggregate([
        { $match: { "payment.status": "PAID" } },
        { $group: { _id: "$user", totalSpend: { $sum: "$totalAmount" } } },
        { $group: { _id: null, avgLTV: { $avg: "$totalSpend" } } },
      ]),
      Booking.distinct("user", { createdAt: { $gte: ninetyDaysAgo } }),
    ]);

    const total = repeatData[0]?.total || 0;
    const repeaters = repeatData[0]?.repeaters || 0;

    return success(res, {
      totalCustomers,
      activeCustomers: activeUserIds.length,
      repeatRate: total > 0 ? Math.round((repeaters / total) * 100) : 0,
      avgLTV: Math.round(ltvData[0]?.avgLTV || 0),
    });
  } catch (error) {
    return fail(res, 500, "ANALYTICS_CUSTOMER_OVERVIEW_FAILED", "Unable to fetch customer overview", error.message);
  }
});

router.get("/customer-trend", async (req, res) => {
  try {
    const days = clampDays(req.query.days);
    const start = daysAgo(days - 1);

    const rows = await User.aggregate([
      { $match: { createdAt: { $gte: start } } },
      {
        $group: {
          _id: { y: { $year: "$createdAt" }, m: { $month: "$createdAt" }, d: { $dayOfMonth: "$createdAt" } },
          newCustomers: { $sum: 1 },
        },
      },
      { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
    ]);

    return success(res, rows);
  } catch (error) {
    return fail(res, 500, "ANALYTICS_CUSTOMER_TREND_FAILED", "Unable to fetch customer trend", error.message);
  }
});

router.get("/top-customers", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const rows = await Booking.aggregate([
      { $match: { "payment.status": "PAID" } },
      {
        $group: {
          _id: "$user",
          totalSpend: { $sum: "$totalAmount" },
          bookings: { $sum: 1 },
          lastBooking: { $max: "$createdAt" },
        },
      },
      { $sort: { totalSpend: -1 } },
      { $limit: limit },
      { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "userDoc" } },
      { $unwind: { path: "$userDoc", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: { $ifNull: ["$userDoc.name", "Unknown"] },
          phone: { $ifNull: ["$userDoc.phone", ""] },
          totalSpend: 1,
          bookings: 1,
          lastBooking: 1,
        },
      },
    ]);

    return success(res, rows);
  } catch (error) {
    return fail(res, 500, "ANALYTICS_TOP_CUSTOMERS_FAILED", "Unable to fetch top customers", error.message);
  }
});

// ─── REVENUE ANALYTICS ─────────────────────────────────────────────────────

router.get("/revenue-overview", async (req, res) => {
  try {
    const [gmvData, refundCount] = await Promise.all([
      Booking.aggregate([
        { $match: { "payment.status": "PAID" } },
        {
          $group: {
            _id: null,
            gmv: { $sum: "$totalAmount" },
            count: { $sum: 1 },
            avgAOV: { $avg: "$totalAmount" },
            totalDiscount: { $sum: "$discountAmount" },
          },
        },
      ]),
      Booking.countDocuments({ status: "CANCELLED", "payment.status": "PAID" }),
    ]);

    const gmv = gmvData[0]?.gmv || 0;
    const count = gmvData[0]?.count || 0;

    return success(res, {
      gmv,
      aov: Math.round(gmvData[0]?.avgAOV || 0),
      totalBookings: count,
      totalDiscount: Math.round(gmvData[0]?.totalDiscount || 0),
      refundCount,
      refundRate: count > 0 ? ((refundCount / count) * 100).toFixed(1) : "0.0",
    });
  } catch (error) {
    return fail(res, 500, "ANALYTICS_REVENUE_OVERVIEW_FAILED", "Unable to fetch revenue overview", error.message);
  }
});

router.get("/aov-trend", async (req, res) => {
  try {
    const days = clampDays(req.query.days);
    const start = daysAgo(days - 1);

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: start }, "payment.status": "PAID" } },
      {
        $group: {
          _id: { y: { $year: "$createdAt" }, m: { $month: "$createdAt" }, d: { $dayOfMonth: "$createdAt" } },
          aov: { $avg: "$totalAmount" },
          bookings: { $sum: 1 },
        },
      },
      { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
    ]);

    return success(res, rows);
  } catch (error) {
    return fail(res, 500, "ANALYTICS_AOV_TREND_FAILED", "Unable to fetch AOV trend", error.message);
  }
});

// ─── PARTNER ANALYTICS ─────────────────────────────────────────────────────

router.get("/partner-overview", async (req, res) => {
  try {
    const [totalApproved, onlineNow, ratingData, completionData] = await Promise.all([
      Partner.countDocuments({ approvalStatus: "APPROVED", isBlocked: false }),
      Partner.countDocuments({ isOnline: true, isBlocked: false }),
      Rating.aggregate([{ $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } }]),
      Booking.aggregate([
        { $match: { partner: { $ne: null } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    return success(res, {
      totalApproved,
      onlineNow,
      avgRating: parseFloat((ratingData[0]?.avg || 0).toFixed(1)),
      totalRatings: ratingData[0]?.count || 0,
      completionRate:
        completionData[0]?.total > 0
          ? ((completionData[0].completed / completionData[0].total) * 100).toFixed(1)
          : "0.0",
    });
  } catch (error) {
    return fail(res, 500, "ANALYTICS_PARTNER_OVERVIEW_FAILED", "Unable to fetch partner overview", error.message);
  }
});

router.get("/partner-leaderboard", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    const rows = await Booking.aggregate([
      { $match: { status: "COMPLETED", partner: { $ne: null } } },
      {
        $group: {
          _id: "$partner",
          jobCount: { $sum: 1 },
          totalRevenue: { $sum: "$totalAmount" },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: limit },
      { $lookup: { from: "partners", localField: "_id", foreignField: "_id", as: "partnerDoc" } },
      { $unwind: { path: "$partnerDoc", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "ratings", localField: "_id", foreignField: "partnerId", as: "ratings" } },
      { $addFields: { avgRating: { $avg: "$ratings.rating" } } },
      {
        $project: {
          name: { $ifNull: ["$partnerDoc.name", "Unknown"] },
          phone: { $ifNull: ["$partnerDoc.phone", ""] },
          jobCount: 1,
          totalRevenue: 1,
          avgRating: { $round: ["$avgRating", 1] },
        },
      },
    ]);

    return success(res, rows);
  } catch (error) {
    return fail(res, 500, "ANALYTICS_PARTNER_LEADERBOARD_FAILED", "Unable to fetch partner leaderboard", error.message);
  }
});

router.get("/rating-distribution", async (req, res) => {
  try {
    const rows = await Rating.aggregate([
      { $group: { _id: "$rating", count: { $sum: 1 } } },
      { $sort: { _id: -1 } },
    ]);

    const dist = [5, 4, 3, 2, 1].map((star) => ({
      stars: star,
      count: rows.find((r) => r._id === star)?.count || 0,
    }));

    return success(res, dist);
  } catch (error) {
    return fail(res, 500, "ANALYTICS_RATING_DIST_FAILED", "Unable to fetch rating distribution", error.message);
  }
});

// ─── OPERATIONS ANALYTICS ──────────────────────────────────────────────────

router.get("/booking-funnel", async (req, res) => {
  try {
    const [total, paid, assigned, inProgress, completed] = await Promise.all([
      Booking.countDocuments({}),
      Booking.countDocuments({ "payment.status": "PAID" }),
      Booking.countDocuments({
        status: { $in: ["ASSIGNED", "CONFIRMED", "PARTNER_ACCEPTED", "ON_THE_WAY", "ARRIVED", "IN_PROGRESS", "COMPLETED"] },
      }),
      Booking.countDocuments({ status: { $in: ["IN_PROGRESS", "COMPLETED"] } }),
      Booking.countDocuments({ status: "COMPLETED" }),
    ]);

    return success(res, [
      { stage: "Booking Created", count: total },
      { stage: "Payment Completed", count: paid },
      { stage: "Partner Assigned", count: assigned },
      { stage: "Service Started", count: inProgress },
      { stage: "Completed", count: completed },
    ]);
  } catch (error) {
    return fail(res, 500, "ANALYTICS_FUNNEL_FAILED", "Unable to fetch booking funnel", error.message);
  }
});

router.get("/cancellation-trend", async (req, res) => {
  try {
    const days = clampDays(req.query.days);
    const start = daysAgo(days - 1);

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: start } } },
      {
        $group: {
          _id: { y: { $year: "$createdAt" }, m: { $month: "$createdAt" }, d: { $dayOfMonth: "$createdAt" } },
          total: { $sum: 1 },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] } },
        },
      },
      { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
    ]);

    return success(res, rows);
  } catch (error) {
    return fail(res, 500, "ANALYTICS_CANCEL_TREND_FAILED", "Unable to fetch cancellation trend", error.message);
  }
});

router.get("/complaint-breakdown", async (req, res) => {
  try {
    const rows = await Complaint.aggregate([
      { $group: { _id: "$issueType", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    return success(res, rows);
  } catch (error) {
    return fail(res, 500, "ANALYTICS_COMPLAINT_BREAKDOWN_FAILED", "Unable to fetch complaint breakdown", error.message);
  }
});

module.exports = router;
