const express = require("express");
const Booking = require("../../../models/Booking");
const Partner = require("../../../models/Partner");
const User = require("../../../models/User");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const { PERMISSIONS } = require("../../constants/permissions");
const { asSingleString } = require("../../utils/common");
const { success, fail } = require("../../utils/response");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.DASHBOARD_READ));

router.get("/kpis", async (req, res) => {
  try {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const [
      totalBookingsToday,
      activePartners,
      pendingJobs,
      completedJobs,
      cancelledJobs,
      newCustomerSignups,
      revenueTodayRows,
    ] = await Promise.all([
      Booking.countDocuments({ createdAt: { $gte: start, $lt: end } }),
      Partner.countDocuments({ isOnline: true, isBlocked: false }),
      Booking.countDocuments({ status: { $in: ["SEARCHING", "ASSIGNED", "PARTNER_ACCEPTED"] } }),
      Booking.countDocuments({ status: "COMPLETED" }),
      Booking.countDocuments({ status: "CANCELLED" }),
      User.countDocuments({ createdAt: { $gte: start, $lt: end } }),
      Booking.aggregate([
        { $match: { createdAt: { $gte: start, $lt: end }, "payment.status": "PAID" } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]),
    ]);

    return success(
      res,
      {
        totalBookingsToday,
        totalRevenueToday: revenueTodayRows[0]?.total || 0,
        activePartners,
        pendingJobs,
        completedJobs,
        cancelledJobs,
        newCustomerSignups,
      },
      { requestId: req.requestId }
    );
  } catch (error) {
    return fail(res, 500, "DASHBOARD_KPI_FAILED", "Unable to fetch dashboard KPIs", error.message, {
      requestId: req.requestId,
    });
  }
});

router.get("/revenue-trend", async (req, res) => {
  try {
    const days = Math.max(1, Math.min(Number(asSingleString(req.query.days) || 14), 90));
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: start }, "payment.status": "PAID" } },
      {
        $group: {
          _id: {
            y: { $year: "$createdAt" },
            m: { $month: "$createdAt" },
            d: { $dayOfMonth: "$createdAt" },
          },
          totalRevenue: { $sum: "$totalAmount" },
        },
      },
      { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
    ]);

    return success(res, rows, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "REVENUE_TREND_FAILED", "Unable to fetch revenue trend", error.message, {
      requestId: req.requestId,
    });
  }
});

router.get("/bookings-trend", async (req, res) => {
  try {
    const days = Math.max(1, Math.min(Number(asSingleString(req.query.days) || 14), 90));
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: start } } },
      {
        $group: {
          _id: {
            y: { $year: "$createdAt" },
            m: { $month: "$createdAt" },
            d: { $dayOfMonth: "$createdAt" },
          },
          totalBookings: { $sum: 1 },
        },
      },
      { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
    ]);

    return success(res, rows, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "BOOKING_TREND_FAILED", "Unable to fetch bookings trend", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
