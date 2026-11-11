const express = require("express");
const Booking = require("../../../models/Booking");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const { PERMISSIONS } = require("../../constants/permissions");
const { asSingleString } = require("../../utils/common");
const { success, fail } = require("../../utils/response");

const router = express.Router();

const TIMEZONE = "Asia/Kolkata";

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

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

    // A refund on record (owed or already paid back) is money the booking no
    // longer keeps, so the tax inside it is not collected either. The tax share
    // of a refund is its share of the total the customer paid, and a refund is
    // never counted past that total (an on-site estimate paid on top of the
    // booking is not part of these figures).
    const addRefundFields = {
      $addFields: {
        refundedAmount: {
          $min: [
            {
              $cond: [
                { $in: [{ $ifNull: ["$refundStatus", "NONE"] }, ["PENDING", "PROCESSED"]] },
                { $ifNull: ["$refundAmount", 0] },
                0,
              ],
            },
            { $ifNull: ["$totalAmount", 0] },
          ],
        },
      },
    };
    const addRefundedGst = {
      $addFields: {
        refundedGstAmount: {
          $cond: [
            { $gt: [{ $ifNull: ["$totalAmount", 0] }, 0] },
            {
              $multiply: [
                { $ifNull: ["$gstAmount", 0] },
                { $divide: ["$refundedAmount", "$totalAmount"] },
              ],
            },
            0,
          ],
        },
      },
    };
    const sums = {
      bookingCount: { $sum: 1 },
      baseAmount: { $sum: "$baseAmount" },
      gstAmount: { $sum: "$gstAmount" },
      totalAmount: { $sum: "$totalAmount" },
      refundedAmount: { $sum: "$refundedAmount" },
      refundedGstAmount: { $sum: "$refundedGstAmount" },
    };

    const [summaryRows, dailyRows] = await Promise.all([
      Booking.aggregate([
        { $match: match },
        addRefundFields,
        addRefundedGst,
        { $group: { _id: null, ...sums } },
      ]),
      Booking.aggregate([
        { $match: match },
        addRefundFields,
        addRefundedGst,
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: TIMEZONE,
              },
            },
            ...sums,
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    // gstAmount / totalAmount stay as collected; the net figures take refunds off.
    const shape = (row) => {
      const gstAmount = round2(row.gstAmount);
      const totalAmount = round2(row.totalAmount);
      const refundedAmount = round2(row.refundedAmount);
      const refundedGstAmount = round2(row.refundedGstAmount);
      return {
        bookingCount: row.bookingCount || 0,
        baseAmount: round2(row.baseAmount),
        gstAmount,
        totalAmount,
        refundedAmount,
        refundedGstAmount,
        netGstAmount: round2(gstAmount - refundedGstAmount),
        netTotalAmount: round2(totalAmount - refundedAmount),
      };
    };

    return success(
      res,
      {
        startDate: startRaw,
        endDate: endRaw,
        timezone: TIMEZONE,
        summary: shape(summaryRows[0] || {}),
        rows: dailyRows.map((row) => ({ date: row._id, ...shape(row) })),
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
