const express = require("express");
const Booking = require("../../../models/Booking");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const { PERMISSIONS } = require("../../constants/permissions");
const { success, fail } = require("../../utils/response");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.ANALYTICS_READ));

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
    return fail(res, 500, "ANALYTICS_CITY_FAILED", "Unable to fetch revenue by city", error.message, {
      requestId: req.requestId,
    });
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
              {
                $ifNull: [{ $arrayElemAt: ["$services.category", 0] }, "unknown"],
              },
            ],
          },
        },
      },
      { $group: { _id: "$category", bookings: { $sum: 1 } } },
      { $sort: { bookings: -1 } },
    ]);

    return success(res, rows, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "ANALYTICS_SERVICE_FAILED", "Unable to fetch service mix", error.message, {
      requestId: req.requestId,
    });
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
    return fail(res, 500, "ANALYTICS_PEAK_HOURS_FAILED", "Unable to fetch peak hours", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
