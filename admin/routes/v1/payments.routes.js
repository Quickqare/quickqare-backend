const express = require("express");
const mongoose = require("mongoose");
const Booking = require("../../../models/Booking");
const PartnerWallet = require("../../../models/PartnerWallet");
const WalletTransaction = require("../../../models/WalletTransaction");
const Withdrawal = require("../../../models/Withdrawal");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const Refund = require("../../models/Refund");
const PayoutBatch = require("../../models/PayoutBatch");
const { PERMISSIONS } = require("../../constants/permissions");
const { getPagination } = require("../../utils/common");
const { success, fail } = require("../../utils/response");

const router = express.Router();

router.use(authenticateAdmin);

router.get("/overview", authorize(PERMISSIONS.PAYMENTS_REFUND), async (req, res) => {
  try {
    const [revenueRows, failedPayments, refunds, wallets, pendingPayouts] = await Promise.all([
      Booking.aggregate([
        { $match: { "payment.status": "PAID" } },
        { $group: { _id: null, totalRevenue: { $sum: "$totalAmount" } } },
      ]),
      Booking.countDocuments({ "payment.status": "FAILED" }),
      Refund.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 }, totalAmountInr: { $sum: "$amountInr" } } },
      ]),
      PartnerWallet.aggregate([{ $group: { _id: null, totalPartnerEarnings: { $sum: "$totalEarnings" } } }]),
      Withdrawal.countDocuments({ status: "PENDING" }),
    ]);

    return success(
      res,
      {
        totalPlatformRevenue: revenueRows[0]?.totalRevenue || 0,
        totalPartnerEarnings: wallets[0]?.totalPartnerEarnings || 0,
        failedPayments,
        refunds,
        pendingPayouts,
      },
      { requestId: req.requestId }
    );
  } catch (error) {
    return fail(res, 500, "PAYMENT_OVERVIEW_FAILED", "Unable to fetch payment overview", error.message, {
      requestId: req.requestId,
    });
  }
});

router.get("/transactions", authorize(PERMISSIONS.PAYMENTS_REFUND), async (req, res) => {
  try {
    const { page, pageSize, skip, limit } = getPagination(req);

    const [rows, total] = await Promise.all([
      WalletTransaction.find()
        .populate("partnerId", "name phone")
        .populate("bookingId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WalletTransaction.countDocuments(),
    ]);

    return success(res, rows, { requestId: req.requestId, pagination: { page, pageSize, total } });
  } catch (error) {
    return fail(res, 500, "PAYMENT_TRANSACTIONS_FAILED", "Unable to fetch transactions", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post(
  "/payouts",
  authorize(PERMISSIONS.PAYMENTS_PAYOUT),
  audit("admin.payments.payouts"),
  async (req, res) => {
    try {
      const items = Array.isArray(req.body.items) ? req.body.items : [];
      if (!items.length) {
        return fail(res, 400, "VALIDATION_ERROR", "items[] is required for payout batch", null, {
          requestId: req.requestId,
        });
      }

      for (const item of items) {
        if (!mongoose.Types.ObjectId.isValid(item.partnerId) || !Number.isFinite(Number(item.amountInr))) {
          return fail(res, 400, "VALIDATION_ERROR", "Each item requires valid partnerId and amountInr", null, {
            requestId: req.requestId,
          });
        }
      }

      const normalizedItems = items.map((item) => ({
        partnerId: item.partnerId,
        amountInr: Number(item.amountInr),
        status: "PENDING",
        referenceId: String(item.referenceId || ""),
      }));
      const totalAmountInr = normalizedItems.reduce((sum, row) => sum + row.amountInr, 0);

      const batch = await PayoutBatch.create({
        createdByAdminId: req.adminUser.id,
        totalAmountInr,
        status: "PENDING",
        items: normalizedItems,
      });

      return success(res, batch, { requestId: req.requestId });
    } catch (error) {
      return fail(res, 500, "PAYOUT_BATCH_FAILED", "Unable to create payout batch", error.message, {
        requestId: req.requestId,
      });
    }
  }
);

module.exports = router;
