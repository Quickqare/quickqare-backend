const express = require("express");
const Booking = require("../../../models/Booking");
const Partner = require("../../../models/Partner");
const User = require("../../../models/User");
const Rating = require("../../../models/Rating");
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

function parseRange(req) {
  const { range, start, end } = req.query;
  const now = new Date();
  let startDate, endDate;

  endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);

  if (start && end) {
    startDate = new Date(start);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);
    return { startDate, endDate };
  }

  switch (String(range || "30d")) {
    case "today":
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now);
      endDate.setHours(23, 59, 59, 999);
      break;
    case "yesterday": {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      startDate = new Date(y);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(y);
      endDate.setHours(23, 59, 59, 999);
      break;
    }
    case "7d":
      startDate = daysAgo(6);
      break;
    case "30d":
      startDate = daysAgo(29);
      break;
    case "month":
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      startDate.setHours(0, 0, 0, 0);
      break;
    case "year":
      startDate = new Date(now.getFullYear(), 0, 1);
      startDate.setHours(0, 0, 0, 0);
      break;
    default: {
      const days = Math.min(Math.max(parseInt(range) || 30, 1), 365);
      startDate = daysAgo(days - 1);
    }
  }

  return { startDate, endDate };
}

// ─── BOOKING OVERVIEW ─────────────────────────────────────────────────────────

router.get("/booking-overview", async (req, res) => {
  try {
    const { startDate, endDate } = parseRange(req);
    const periodMs = endDate.getTime() - startDate.getTime();
    const prevEnd = new Date(startDate.getTime() - 1);
    const prevStart = new Date(prevEnd.getTime() - periodMs);

    const [cur, prev, settlement] = await Promise.all([
      Booking.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] } },
            active: {
              $sum: {
                $cond: [
                  { $in: ["$status", ["ASSIGNED", "CONFIRMED", "PARTNER_ACCEPTED", "ON_THE_WAY", "ARRIVED", "IN_PROGRESS"]] },
                  1,
                  0,
                ],
              },
            },
            pendingPayments: { $sum: { $cond: [{ $ne: ["$payment.status", "PAID"] }, 1, 0] } },
          },
        },
      ]),
      Booking.countDocuments({ createdAt: { $gte: prevStart, $lte: prevEnd } }),
      Booking.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate, $lte: endDate },
            status: "COMPLETED",
          },
        },
        {
          $group: {
            _id: null,
            commission: { $sum: "$partnerSettlement.commissionAmount" },
            technicianEarnings: { $sum: "$partnerSettlement.partnerEarningAmount" },
          },
        },
      ]),
    ]);

    const total = cur[0]?.total || 0;
    const growthPct = prev > 0 ? (((total - prev) / prev) * 100).toFixed(1) : null;

    return success(res, {
      total,
      completed: cur[0]?.completed || 0,
      cancelled: cur[0]?.cancelled || 0,
      active: cur[0]?.active || 0,
      pendingPayments: cur[0]?.pendingPayments || 0,
      growthPct,
      commission: Math.round(settlement[0]?.commission || 0),
      technicianEarnings: Math.round(settlement[0]?.technicianEarnings || 0),
    });
  } catch (error) {
    return fail(res, 500, "ANALYTICS_BOOKING_OVERVIEW_FAILED", "Unable to fetch booking overview", error.message);
  }
});

// ─── REVENUE ANALYTICS ────────────────────────────────────────────────────────

router.get("/revenue-overview", async (req, res) => {
  try {
    const { startDate, endDate } = parseRange(req);

    const [gmvData, refundCount] = await Promise.all([
      Booking.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: endDate }, "payment.status": "PAID" } },
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
      Booking.countDocuments({
        createdAt: { $gte: startDate, $lte: endDate },
        status: "CANCELLED",
        "payment.status": "PAID",
      }),
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
    const { startDate, endDate } = parseRange(req);

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: startDate, $lte: endDate }, "payment.status": "PAID" } },
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

router.get("/revenue-by-city", async (req, res) => {
  try {
    const { startDate, endDate } = parseRange(req);

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: startDate, $lte: endDate }, "payment.status": "PAID" } },
      { $group: { _id: "$pincode", totalRevenue: { $sum: "$totalAmount" }, bookings: { $sum: 1 } } },
      { $sort: { totalRevenue: -1 } },
      { $limit: 100 },
    ]);
    return success(res, rows, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "ANALYTICS_CITY_FAILED", "Unable to fetch revenue by city", error.message);
  }
});

router.get("/service-mix", async (req, res) => {
  try {
    const { startDate, endDate } = parseRange(req);

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
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
    return success(res, rows);
  } catch (error) {
    return fail(res, 500, "ANALYTICS_SERVICE_FAILED", "Unable to fetch service mix", error.message);
  }
});

// ─── SERVICE ANALYTICS (NEW) ──────────────────────────────────────────────────

router.get("/service-analytics", async (req, res) => {
  try {
    const { startDate, endDate } = parseRange(req);
    const match = { createdAt: { $gte: startDate, $lte: endDate } };

    const [mostBooked, highestRevenue, peakDays] = await Promise.all([
      Booking.aggregate([
        { $match: match },
        { $unwind: { path: "$services", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: {
              $ifNull: [
                "$services.name",
                { $ifNull: ["$serviceCategory", "Other"] },
              ],
            },
            bookings: { $sum: 1 },
            revenue: { $sum: { $ifNull: ["$services.price", "$totalAmount"] } },
          },
        },
        { $sort: { bookings: -1 } },
        { $limit: 10 },
      ]),
      Booking.aggregate([
        { $match: { ...match, "payment.status": "PAID" } },
        { $unwind: { path: "$services", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: {
              $ifNull: [
                "$services.name",
                { $ifNull: ["$serviceCategory", "Other"] },
              ],
            },
            revenue: { $sum: "$totalAmount" },
            bookings: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
      ]),
      Booking.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $dayOfWeek: "$createdAt" },
            bookings: { $sum: 1 },
          },
        },
        { $sort: { bookings: -1 } },
      ]),
    ]);

    const DAY_NAMES = ["", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const peakDaysMapped = peakDays.map((d) => ({
      _id: DAY_NAMES[d._id] || String(d._id),
      bookings: d.bookings,
    }));

    return success(res, { mostBooked, highestRevenue, peakDays: peakDaysMapped });
  } catch (error) {
    return fail(res, 500, "ANALYTICS_SERVICE_ANALYTICS_FAILED", "Unable to fetch service analytics", error.message);
  }
});

// ─── PEAK HOURS ────────────────────────────────────────────────────────────────

router.get("/peak-hours", async (req, res) => {
  try {
    const { startDate, endDate } = parseRange(req);

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
      { $group: { _id: "$scheduledTime", bookings: { $sum: 1 } } },
      { $sort: { bookings: -1 } },
      { $limit: 24 },
    ]);
    return success(res, rows);
  } catch (error) {
    return fail(res, 500, "ANALYTICS_PEAK_HOURS_FAILED", "Unable to fetch peak hours", error.message);
  }
});

// ─── CUSTOMER ANALYTICS ───────────────────────────────────────────────────────

router.get("/customer-overview", async (req, res) => {
  try {
    const { startDate, endDate } = parseRange(req);

    const [totalCustomers, repeatData, ltvData, activeUserIds, newInPeriod] = await Promise.all([
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
      Booking.distinct("user", { createdAt: { $gte: startDate, $lte: endDate } }),
      User.countDocuments({ createdAt: { $gte: startDate, $lte: endDate } }),
    ]);

    const total = repeatData[0]?.total || 0;
    const repeaters = repeatData[0]?.repeaters || 0;

    return success(res, {
      totalCustomers,
      activeCustomers: activeUserIds.length,
      newCustomers: newInPeriod,
      repeatRate: total > 0 ? Math.round((repeaters / total) * 100) : 0,
      retentionRate: totalCustomers > 0 ? Math.round((activeUserIds.length / totalCustomers) * 100) : 0,
      avgLTV: Math.round(ltvData[0]?.avgLTV || 0),
    });
  } catch (error) {
    return fail(res, 500, "ANALYTICS_CUSTOMER_OVERVIEW_FAILED", "Unable to fetch customer overview", error.message);
  }
});

router.get("/customer-trend", async (req, res) => {
  try {
    const { startDate, endDate } = parseRange(req);

    const rows = await User.aggregate([
      { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
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

// ─── PARTNER ANALYTICS ────────────────────────────────────────────────────────

router.get("/partner-overview", async (req, res) => {
  try {
    const { startDate, endDate } = parseRange(req);

    const [totalApproved, onlineNow, ratingData, completionData, acceptanceData] = await Promise.all([
      Partner.countDocuments({ approvalStatus: "APPROVED", isBlocked: false }),
      Partner.countDocuments({ isOnline: true, isBlocked: false }),
      Rating.aggregate([{ $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } }]),
      Booking.aggregate([
        { $match: { partner: { $ne: null }, createdAt: { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] } },
          },
        },
      ]),
      Booking.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: endDate }, partner: { $ne: null } } },
        {
          $group: {
            _id: null,
            assigned: { $sum: 1 },
            accepted: {
              $sum: {
                $cond: [
                  { $in: ["$status", ["PARTNER_ACCEPTED", "ON_THE_WAY", "ARRIVED", "IN_PROGRESS", "COMPLETED"]] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
    ]);

    const total = completionData[0]?.total || 0;
    const assigned = acceptanceData[0]?.assigned || 0;

    return success(res, {
      totalApproved,
      onlineNow,
      avgRating: parseFloat((ratingData[0]?.avg || 0).toFixed(1)),
      totalRatings: ratingData[0]?.count || 0,
      completionRate: total > 0 ? ((completionData[0].completed / total) * 100).toFixed(1) : "0.0",
      cancellationRate: total > 0 ? ((completionData[0].cancelled / total) * 100).toFixed(1) : "0.0",
      acceptanceRate: assigned > 0 ? ((acceptanceData[0].accepted / assigned) * 100).toFixed(1) : "0.0",
    });
  } catch (error) {
    return fail(res, 500, "ANALYTICS_PARTNER_OVERVIEW_FAILED", "Unable to fetch partner overview", error.message);
  }
});

router.get("/partner-leaderboard", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const { startDate, endDate } = parseRange(req);

    const rows = await Booking.aggregate([
      { $match: { status: "COMPLETED", partner: { $ne: null }, createdAt: { $gte: startDate, $lte: endDate } } },
      {
        $group: {
          _id: "$partner",
          jobCount: { $sum: 1 },
          totalRevenue: { $sum: "$totalAmount" },
          totalEarnings: { $sum: "$partnerSettlement.partnerEarningAmount" },
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
          totalEarnings: 1,
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

// ─── OPERATIONS ANALYTICS ─────────────────────────────────────────────────────

router.get("/booking-funnel", async (req, res) => {
  try {
    const { startDate, endDate } = parseRange(req);
    const match = { createdAt: { $gte: startDate, $lte: endDate } };

    const [total, paid, assigned, inProgress, completed] = await Promise.all([
      Booking.countDocuments(match),
      Booking.countDocuments({ ...match, "payment.status": "PAID" }),
      Booking.countDocuments({
        ...match,
        status: { $in: ["ASSIGNED", "CONFIRMED", "PARTNER_ACCEPTED", "ON_THE_WAY", "ARRIVED", "IN_PROGRESS", "COMPLETED"] },
      }),
      Booking.countDocuments({ ...match, status: { $in: ["IN_PROGRESS", "COMPLETED"] } }),
      Booking.countDocuments({ ...match, status: "COMPLETED" }),
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
    const { startDate, endDate } = parseRange(req);

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
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
    const { startDate, endDate } = parseRange(req);

    const rows = await Complaint.aggregate([
      { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
      { $group: { _id: "$issueType", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    return success(res, rows);
  } catch (error) {
    return fail(res, 500, "ANALYTICS_COMPLAINT_BREAKDOWN_FAILED", "Unable to fetch complaint breakdown", error.message);
  }
});

// ─── GEOGRAPHIC ANALYTICS ─────────────────────────────────────────────────────

router.get("/geographic", async (req, res) => {
  try {
    const { startDate, endDate } = parseRange(req);

    const [demand, supply] = await Promise.all([
      Booking.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: "$pincode", bookings: { $sum: 1 }, revenue: { $sum: "$totalAmount" } } },
        { $sort: { bookings: -1 } },
        { $limit: 20 },
      ]),
      Partner.aggregate([
        { $match: { approvalStatus: "APPROVED", isBlocked: false } },
        { $unwind: { path: "$serviceAreas", preserveNullAndEmptyArrays: false } },
        { $group: { _id: "$serviceAreas", partners: { $sum: 1 } } },
        { $sort: { partners: -1 } },
        { $limit: 20 },
      ]),
    ]);

    const supplyMap = Object.fromEntries(supply.map((s) => [s._id, s.partners]));
    const rows = demand.map((d) => ({
      pincode: d._id,
      bookings: d.bookings,
      revenue: d.revenue,
      partners: supplyMap[d._id] || 0,
      gap: d.bookings - (supplyMap[d._id] || 0) * 3,
    }));

    return success(res, rows);
  } catch (error) {
    return fail(res, 500, "ANALYTICS_GEOGRAPHIC_FAILED", "Unable to fetch geographic analytics", error.message);
  }
});

// ─── LIVE STATS ───────────────────────────────────────────────────────────────

router.get("/live-stats", async (req, res) => {
  try {
    const [onlinePartners, ongoingJobs, upcomingJobs, pendingAssignment, recentBookings] = await Promise.all([
      Partner.countDocuments({ isOnline: true, isBlocked: false }),
      Booking.countDocuments({ status: { $in: ["IN_PROGRESS", "ARRIVED"] } }),
      Booking.countDocuments({ status: { $in: ["PARTNER_ACCEPTED", "ON_THE_WAY"] } }),
      Booking.countDocuments({ status: { $in: ["SEARCHING", "QUEUED", "PENDING_ASSIGNMENT", "ASSIGNED", "CONFIRMED"] } }),
      Booking.find({ status: { $in: ["IN_PROGRESS", "ARRIVED", "PARTNER_ACCEPTED", "ON_THE_WAY", "ASSIGNED", "CONFIRMED"] } })
        .sort({ scheduledDate: 1 })
        .limit(10)
        .select("bookingNumber status scheduledDate scheduledTime serviceCategory totalAmount")
        .lean(),
    ]);

    return success(res, {
      onlinePartners,
      ongoingJobs,
      upcomingJobs,
      pendingAssignment,
      recentBookings,
    });
  } catch (error) {
    return fail(res, 500, "ANALYTICS_LIVE_STATS_FAILED", "Unable to fetch live stats", error.message);
  }
});

module.exports = router;
