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
    let start, end;

    if (req.query.start && req.query.end) {
      start = new Date(req.query.start);
      end   = new Date(req.query.end);
    } else {
      start = new Date(now); start.setHours(0, 0, 0, 0);
      end   = new Date(now); end.setHours(23, 59, 59, 999);
    }

    const dateFilter = { createdAt: { $gte: start, $lte: end } };

    const [
      totalBookings,
      activePartners,
      pendingJobs,
      completedJobs,
      cancelledJobs,
      newCustomerSignups,
      revenueRows,
    ] = await Promise.all([
      Booking.countDocuments(dateFilter),
      Partner.countDocuments({ isOnline: true, isBlocked: false }),
      Booking.countDocuments({ status: { $in: ["SEARCHING", "ASSIGNED", "PARTNER_ACCEPTED"] } }),
      Booking.countDocuments({ status: "COMPLETED", ...dateFilter }),
      Booking.countDocuments({ status: "CANCELLED", ...dateFilter }),
      User.countDocuments(dateFilter),
      Booking.aggregate([
        { $match: { ...dateFilter, "payment.status": "PAID" } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]),
    ]);

    return success(
      res,
      {
        totalBookings,
        totalRevenue: revenueRows[0]?.total || 0,
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
    let start, end;
    if (req.query.start && req.query.end) {
      start = new Date(req.query.start);
      end   = new Date(req.query.end);
    } else {
      const days = Math.max(1, Math.min(Number(asSingleString(req.query.days) || 14), 90));
      start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
      end   = new Date(); end.setHours(23, 59, 59, 999);
    }

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end }, "payment.status": "PAID" } },
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
    let start, end;
    if (req.query.start && req.query.end) {
      start = new Date(req.query.start);
      end   = new Date(req.query.end);
    } else {
      const days = Math.max(1, Math.min(Number(asSingleString(req.query.days) || 14), 90));
      start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
      end   = new Date(); end.setHours(23, 59, 59, 999);
    }

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
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
