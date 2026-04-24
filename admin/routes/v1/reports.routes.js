const express = require("express");
const Booking = require("../../../models/Booking");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const { PERMISSIONS } = require("../../constants/permissions");
const { asSingleString } = require("../../utils/common");
const { success, fail } = require("../../utils/response");

const router = express.Router();

const TIMEZONE = "Asia/Kolkata";

const parseDateOnly = (value, endOfDay = false) => {
  if (!value) return null;
  const suffix = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  const date = new Date(`${value}${suffix}`);
  return Number.isNaN(date.getTime()) ? null : date;
};

router.use(authenticateAdmin);
router.use(authorize(PERMISSIONS.AUDIT_READ));

router.get("/gst", async (req, res) => {
  try {
    const startRaw = asSingleString(req.query.start);
    const endRaw = asSingleString(req.query.end);

    const startDate = parseDateOnly(startRaw);
    const endDate = parseDateOnly(endRaw, true);

    if (!startDate || !endDate) {
      return fail(res, 400, "VALIDATION_ERROR", "start and end (YYYY-MM-DD) are required", null, {
        requestId: req.requestId,
      });
    }

    if (startDate > endDate) {
      return fail(res, 400, "VALIDATION_ERROR", "start must be before end", null, {
        requestId: req.requestId,
      });
    }

    const match = {
      "payment.status": "PAID",
      createdAt: { $gte: startDate, $lte: endDate },
    };

    const [summaryRows, dailyRows] = await Promise.all([
      Booking.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            bookingCount: { $sum: 1 },
            baseAmount: { $sum: "$baseAmount" },
            gstAmount: { $sum: "$gstAmount" },
            totalAmount: { $sum: "$totalAmount" },
          },
        },
      ]),
      Booking.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: TIMEZONE,
              },
            },
            bookingCount: { $sum: 1 },
            baseAmount: { $sum: "$baseAmount" },
            gstAmount: { $sum: "$gstAmount" },
            totalAmount: { $sum: "$totalAmount" },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const summary = summaryRows[0] || {
      bookingCount: 0,
      baseAmount: 0,
      gstAmount: 0,
      totalAmount: 0,
    };

    return success(
      res,
      {
        startDate: startRaw,
        endDate: endRaw,
        timezone: TIMEZONE,
        summary,
        rows: dailyRows.map((row) => ({
          date: row._id,
          bookingCount: row.bookingCount || 0,
          baseAmount: row.baseAmount || 0,
          gstAmount: row.gstAmount || 0,
          totalAmount: row.totalAmount || 0,
        })),
      },
      { requestId: req.requestId }
    );
  } catch (error) {
    return fail(res, 500, "GST_REPORT_FAILED", "Unable to generate GST report", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
