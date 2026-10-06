const express = require("express");
const mongoose = require("mongoose");
const Booking = require("../../../models/Booking");
const PartnerWallet = require("../../../models/PartnerWallet");
const WalletTransaction = require("../../../models/WalletTransaction");
const Withdrawal = require("../../../models/Withdrawal");
const Partner = require("../../../models/Partner");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const Refund = require("../../models/Refund");
const PayoutBatch = require("../../models/PayoutBatch");
const { settleRefund, round2 } = require("../../services/refund.service");
const { PERMISSIONS } = require("../../constants/permissions");
const { getPagination, asSingleString } = require("../../utils/common");
const { success, fail } = require("../../utils/response");
const PartnerPayoutAccount = require("../../../models/PartnerPayoutAccount");
const { decryptBankDetails, decryptField } = require("../../../utils/fieldCrypto");
const { debitWallet } = require("../../../controllers/partnerWallet.controller");
const { notifyPartner } = require("../../../services/pushNotification.service");

const inr = (amount) => `₹${Number(amount || 0).toLocaleString("en-IN")}`;

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

/* =====================================================
   CUSTOMER REFUNDS OWED
   GET /api/v1/admin/payments/refunds?status=PENDING
   Every booking with a refund on record: customer cancellations, the stale
   auto-cancel, a payment captured for a dead booking, an admin cancel, an
   admin-requested refund. All of those only set refundStatus=PENDING — this
   is the one place that lists them, so they get paid instead of forgotten.
===================================================== */
router.get("/refunds", authorize(PERMISSIONS.PAYMENTS_REFUND), async (req, res) => {
  try {
    const { page, pageSize, skip, limit } = getPagination(req);
    const status = String(asSingleString(req.query.status) || "").toUpperCase();
    const refundStatus = ["PENDING", "PROCESSED", "FAILED"].includes(status) ? status : "PENDING";
    const filter = { refundStatus };

    const [rows, total] = await Promise.all([
      Booking.find(filter)
        .select(
          "user status totalAmount refundAmount refundedAmount refundStatus refundProcessedAt cancelledBy cancelledAt cancelReason " +
            "payment.razorpay_payment_id payment.razorpay_refund_id " +
            "estimatePayment.status estimatePayment.razorpay_payment_id"
        )
        .populate("user", "name phone")
        // Still owed: longest-waiting first. Already paid back: newest first.
        .sort(refundStatus === "PROCESSED" ? { refundProcessedAt: -1 } : { cancelledAt: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Booking.countDocuments(filter),
    ]);

    // A refund an admin requested by hand carries its reason on the Refund doc.
    const requested = await Refund.find({ bookingId: { $in: rows.map((row) => row._id) } })
      .select("bookingId reason")
      .sort({ createdAt: 1 })
      .lean();
    const requestedReason = new Map(requested.map((refund) => [String(refund.bookingId), refund.reason]));

    const data = rows.map((row) => {
      // While PENDING, what to pay now is the total on record minus what
      // already went back (a further refund on a booking refunded once before).
      const alreadyRefunded = row.refundStatus === "PENDING" ? Number(row.refundedAmount || 0) : 0;
      const stillOwed = row.refundStatus === "PENDING";
      return {
        bookingId: row._id,
        customer: row.user ? { name: row.user.name, phone: row.user.phone } : null,
        bookingStatus: row.status,
        totalAmount: row.totalAmount || 0,
        refundAmount: Math.max(0, round2(Number(row.refundAmount || 0) - alreadyRefunded)),
        alreadyRefunded,
        refundStatus: row.refundStatus,
        refundProcessedAt: row.refundProcessedAt || null,
        reason: requestedReason.get(String(row._id)) || row.cancelReason || "",
        cancelledBy: row.cancelledBy || null,
        cancelledAt: row.cancelledAt || null,
        // What to look up in the Razorpay dashboard to issue the refund.
        paymentId: row.payment?.razorpay_payment_id || null,
        estimatePaymentId:
          row.estimatePayment?.status === "PAID" ? row.estimatePayment.razorpay_payment_id || null : null,
        // Set while still PENDING with nothing paid back yet = the instant
        // auto-refund went out but its status write was lost: check the
        // dashboard before refunding again. With an earlier refund on record
        // it is only that refund's id, not this one's.
        refundReference: stillOwed && alreadyRefunded > 0 ? null : row.payment?.razorpay_refund_id || null,
      };
    });

    return success(res, data, { requestId: req.requestId, pagination: { page, pageSize, total } });
  } catch (error) {
    return fail(res, 500, "REFUNDS_LIST_FAILED", "Unable to fetch refunds", error.message, {
      requestId: req.requestId,
    });
  }
});

/* =====================================================
   MARK A CUSTOMER REFUND AS PAID BACK
   POST /api/v1/admin/payments/refunds/:id/complete   (:id = booking id)
   Body: { referenceId } — the Razorpay refund id (rfnd_…) of the refund the
   admin already issued. Claim-first, like withdrawals: only the request that
   flips PENDING → PROCESSED wins, so a double click or two admins can't both
   record it.
===================================================== */
router.post(
  "/refunds/:id/complete",
  authorize(PERMISSIONS.PAYMENTS_REFUND),
  audit("admin.payments.refund.complete"),
  async (req, res) => {
    try {
      const bookingId = asSingleString(req.params.id);
      if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
        return fail(res, 400, "INVALID_ID", "Invalid booking id", null, { requestId: req.requestId });
      }

      const referenceId = String(req.body.referenceId || "").trim().slice(0, 100);
      if (!referenceId) {
        return fail(
          res,
          400,
          "VALIDATION_ERROR",
          "Enter the Razorpay refund ID of the refund you issued",
          null,
          { requestId: req.requestId }
        );
      }

      const settled = await settleRefund({ bookingId, referenceId, adminId: req.adminUser.id });
      if (!settled) {
        const exists = await Booking.exists({ _id: bookingId });
        return exists
          ? fail(res, 400, "ALREADY_PROCESSED", "This booking has no pending refund", null, { requestId: req.requestId })
          : fail(res, 404, "NOT_FOUND", "Booking not found", null, { requestId: req.requestId });
      }

      return success(res, settled, { requestId: req.requestId });
    } catch (error) {
      return fail(res, 500, "REFUND_COMPLETE_FAILED", "Unable to mark the refund as paid", error.message, {
        requestId: req.requestId,
      });
    }
  }
);

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

/* =====================================================
   LIST WITHDRAWAL REQUESTS
   GET /api/v1/admin/payments/withdrawals
===================================================== */
router.get(
  "/withdrawals",
  authorize(PERMISSIONS.PAYMENTS_PAYOUT),
  async (req, res) => {
    try {
      const { page, pageSize, skip, limit } = getPagination(req);
      const status = asSingleString(req.query.status);
      const filter = status ? { status } : {};

      const [rows, total] = await Promise.all([
        Withdrawal.find(filter)
          .populate("partnerId", "name phone")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Withdrawal.countDocuments(filter),
      ]);

      // Decrypt the at-rest destination so the admin sees the real account
      // number/IFSC or UPI ID needed to make the payout. rows are lean →
      // mutate in place. Legacy rows (no payoutMethod) are always bank.
      for (const row of rows) {
        row.payoutMethod = row.payoutMethod || "BANK";
        if (row.bankDetails) row.bankDetails = decryptBankDetails(row.bankDetails);
        if (row.upiId) row.upiId = decryptField(row.upiId);
      }

      return success(res, rows, {
        requestId: req.requestId,
        pagination: { page, pageSize, total },
      });
    } catch (error) {
      return fail(res, 500, "WITHDRAWALS_LIST_FAILED", "Unable to fetch withdrawals", error.message, {
        requestId: req.requestId,
      });
    }
  }
);

/* =====================================================
   APPROVE WITHDRAWAL
   PATCH /api/v1/admin/payments/withdrawals/:id/approve
   Body: { referenceId }  — UTR of the transfer the admin already made.

   The PENDING → APPROVED flip is a status-guarded claim done FIRST, so two
   admins (or a double click) can't both approve, and approve can't race a
   reject. Wallet bookkeeping runs only for the request that won the claim;
   if it fails, the claim is rolled back to PENDING.
===================================================== */
router.patch(
  "/withdrawals/:id/approve",
  authorize(PERMISSIONS.PAYMENTS_PAYOUT),
  audit("admin.payments.withdrawal.approve"),
  async (req, res) => {
    try {
      const id = asSingleString(req.params.id);
      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return fail(res, 400, "INVALID_ID", "Invalid withdrawal id", null, { requestId: req.requestId });
      }

      const referenceId = String(req.body.referenceId || "").trim().slice(0, 100);
      if (!referenceId) {
        return fail(
          res,
          400,
          "VALIDATION_ERROR",
          "Enter the UTR / transaction reference of the transfer you made",
          null,
          { requestId: req.requestId }
        );
      }

      const withdrawal = await Withdrawal.findOneAndUpdate(
        { _id: id, status: "PENDING" },
        {
          $set: {
            status: "APPROVED",
            referenceId,
            processedBy: req.adminUser.id,
            processedAt: new Date(),
          },
        },
        { new: true }
      );
      if (!withdrawal) {
        const exists = await Withdrawal.exists({ _id: id });
        return exists
          ? fail(res, 400, "ALREADY_PROCESSED", "Withdrawal already processed", null, { requestId: req.requestId })
          : fail(res, 404, "NOT_FOUND", "Withdrawal not found", null, { requestId: req.requestId });
      }

      try {
        if (withdrawal.balanceHeld) {
          // Funds were already reserved out of withdrawableBalance when the
          // partner submitted the request. Approving must NOT debit again —
          // just move the held amount into totalWithdrawn and write the ledger row.
          await PartnerWallet.updateOne(
            { partnerId: withdrawal.partnerId },
            {
              $inc: { totalWithdrawn: withdrawal.amount },
              $set: { lastUpdated: new Date() },
            }
          );
          await WalletTransaction.create({
            partnerId: withdrawal.partnerId,
            amount: withdrawal.amount,
            type: "debit",
            reason: "withdrawal",
            status: "success",
            referenceId,
            description: `Withdrawal paid. Ref: ${referenceId}`,
          });
        } else {
          // Legacy request (no hold at creation) — debit now. Throws if insufficient balance.
          await debitWallet({
            partnerId: withdrawal.partnerId,
            amount: withdrawal.amount,
            reason: "withdrawal",
            description: `Withdrawal paid. Ref: ${referenceId}`,
          });
        }
      } catch (bookkeepingError) {
        await Withdrawal.updateOne(
          { _id: id, status: "APPROVED" },
          { $set: { status: "PENDING", referenceId: null, processedBy: null, processedAt: null } }
        );
        throw bookkeepingError;
      }

      notifyPartner(withdrawal.partnerId, {
        type: "WITHDRAWAL_APPROVED",
        title: "Withdrawal paid",
        body: `${inr(withdrawal.amount)} has been sent to your ${
          withdrawal.payoutMethod === "UPI" ? "UPI ID" : "bank account"
        }. Ref: ${referenceId}`,
        data: { withdrawalId: String(withdrawal._id) },
      });

      return success(res, withdrawal, { requestId: req.requestId });
    } catch (error) {
      return fail(res, 500, "WITHDRAWAL_APPROVE_FAILED", error.message || "Unable to approve withdrawal", error.message, {
        requestId: req.requestId,
      });
    }
  }
);

/* =====================================================
   REJECT WITHDRAWAL
   PATCH /api/v1/admin/payments/withdrawals/:id/reject
   Same claim-first pattern as approve: only the request that flips
   PENDING → REJECTED returns the held amount, so concurrent rejects can't
   refund it twice.
===================================================== */
router.patch(
  "/withdrawals/:id/reject",
  authorize(PERMISSIONS.PAYMENTS_PAYOUT),
  audit("admin.payments.withdrawal.reject"),
  async (req, res) => {
    try {
      const id = asSingleString(req.params.id);
      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return fail(res, 400, "INVALID_ID", "Invalid withdrawal id", null, { requestId: req.requestId });
      }

      const reason = String(req.body.reason || "").trim().slice(0, 300);

      const withdrawal = await Withdrawal.findOneAndUpdate(
        { _id: id, status: "PENDING" },
        {
          $set: {
            status: "REJECTED",
            reason,
            processedBy: req.adminUser.id,
            processedAt: new Date(),
          },
        },
        { new: true }
      );
      if (!withdrawal) {
        const exists = await Withdrawal.exists({ _id: id });
        return exists
          ? fail(res, 400, "ALREADY_PROCESSED", "Withdrawal already processed", null, { requestId: req.requestId })
          : fail(res, 404, "NOT_FOUND", "Withdrawal not found", null, { requestId: req.requestId });
      }

      if (withdrawal.balanceHeld) {
        // The amount was reserved out of withdrawableBalance at request time.
        // Rejecting returns it to the partner's withdrawable bucket.
        try {
          await PartnerWallet.findOneAndUpdate(
            { partnerId: withdrawal.partnerId },
            [
              {
                $set: {
                  withdrawableBalance: {
                    $round: [{ $add: [{ $ifNull: ["$withdrawableBalance", 0] }, withdrawal.amount] }, 2],
                  },
                  lastUpdated: new Date(),
                },
              },
              { $set: { balance: "$withdrawableBalance" } },
            ]
          );
        } catch (refundError) {
          await Withdrawal.updateOne(
            { _id: id, status: "REJECTED" },
            { $set: { status: "PENDING", reason: "", processedBy: null, processedAt: null } }
          );
          throw refundError;
        }
      }

      notifyPartner(withdrawal.partnerId, {
        type: "WITHDRAWAL_REJECTED",
        title: "Withdrawal not processed",
        body: `Your withdrawal of ${inr(withdrawal.amount)} was not processed${
          reason ? `: ${reason}` : ""
        }. The amount is back in your wallet.`,
        data: { withdrawalId: String(withdrawal._id) },
      });

      return success(res, withdrawal, { requestId: req.requestId });
    } catch (error) {
      return fail(res, 500, "WITHDRAWAL_REJECT_FAILED", "Unable to reject withdrawal", error.message, {
        requestId: req.requestId,
      });
    }
  }
);

/* =====================================================
   LIST PARTNER PAYOUT ACCOUNTS
   GET /api/v1/admin/payments/payout-accounts?status=PENDING
   Full (decrypted) details: the admin checks the holder name against the
   partner before verifying.
===================================================== */
router.get(
  "/payout-accounts",
  authorize(PERMISSIONS.PAYMENTS_PAYOUT),
  async (req, res) => {
    try {
      const { page, pageSize, skip, limit } = getPagination(req);
      const status = String(asSingleString(req.query.status) || "").toUpperCase();
      const filter = ["PENDING", "VERIFIED", "REJECTED"].includes(status) ? { status } : {};

      const [rows, total] = await Promise.all([
        PartnerPayoutAccount.find(filter)
          .populate("partnerId", "name phone")
          .sort({ submittedAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        PartnerPayoutAccount.countDocuments(filter),
      ]);

      const data = rows.map((row) => ({
        _id: row._id,
        partner: row.partnerId
          ? { id: row.partnerId._id, name: row.partnerId.name, phone: row.partnerId.phone }
          : null,
        method: row.method,
        accountHolderName: row.accountHolderName || "",
        accountNumber: row.method === "BANK" ? decryptField(row.accountNumber) : "",
        ifsc: row.method === "BANK" ? decryptField(row.ifsc) : "",
        bankName: row.bankName || "",
        upiId: row.method === "UPI" ? decryptField(row.upiId) : "",
        status: row.status,
        rejectionReason: row.rejectionReason || "",
        revision: row.revision,
        submittedAt: row.submittedAt,
        verifiedAt: row.verifiedAt,
        withdrawalsBlockedUntil: row.withdrawalsBlockedUntil,
      }));

      return success(res, data, {
        requestId: req.requestId,
        pagination: { page, pageSize, total },
      });
    } catch (error) {
      return fail(res, 500, "PAYOUT_ACCOUNTS_LIST_FAILED", "Unable to fetch payout accounts", error.message, {
        requestId: req.requestId,
      });
    }
  }
);

/* =====================================================
   VERIFY / REJECT A PAYOUT ACCOUNT
   PATCH /api/v1/admin/payments/payout-accounts/:id/verify
   Body: { status: "VERIFIED" | "REJECTED", revision, reason? }
   `revision` must match what the admin was shown: if the partner resubmitted
   in the meantime the update matches nothing and the admin must reload, so
   unseen details can never be verified.
===================================================== */
router.patch(
  "/payout-accounts/:id/verify",
  authorize(PERMISSIONS.PAYMENTS_PAYOUT),
  audit("admin.payments.payout_account.verify"),
  async (req, res) => {
    try {
      const id = asSingleString(req.params.id);
      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return fail(res, 400, "INVALID_ID", "Invalid payout account id", null, { requestId: req.requestId });
      }

      const status = String(req.body.status || "").toUpperCase();
      const reason = String(req.body.reason || "").trim().slice(0, 300);
      const revision = Number(req.body.revision);

      if (!["VERIFIED", "REJECTED"].includes(status)) {
        return fail(res, 400, "VALIDATION_ERROR", "status must be VERIFIED or REJECTED", null, { requestId: req.requestId });
      }
      if (status === "REJECTED" && !reason) {
        return fail(res, 400, "VALIDATION_ERROR", "Give a reason so the partner knows what to fix", null, {
          requestId: req.requestId,
        });
      }
      if (!Number.isInteger(revision)) {
        return fail(res, 400, "VALIDATION_ERROR", "revision is required", null, { requestId: req.requestId });
      }

      const account = await PartnerPayoutAccount.findOneAndUpdate(
        { _id: id, status: "PENDING", revision },
        {
          $set: {
            status,
            rejectionReason: status === "REJECTED" ? reason : "",
            verifiedAt: status === "VERIFIED" ? new Date() : null,
            verifiedBy: req.adminUser.id,
          },
        },
        { new: true }
      ).lean();

      if (!account) {
        const current = await PartnerPayoutAccount.findById(id).select("status revision").lean();
        if (!current) {
          return fail(res, 404, "NOT_FOUND", "Payout account not found", null, { requestId: req.requestId });
        }
        if (current.revision !== revision) {
          return fail(res, 409, "STALE_REVISION", "The partner changed these details since you loaded them. Reload and check again.", null, {
            requestId: req.requestId,
          });
        }
        return fail(res, 400, "ALREADY_PROCESSED", "Payout account already processed", null, { requestId: req.requestId });
      }

      notifyPartner(account.partnerId, {
        type: "PAYOUT_ACCOUNT_STATUS",
        title: status === "VERIFIED" ? "Payout account verified" : "Payout account rejected",
        body:
          status === "VERIFIED"
            ? "Your payout account is verified. You can now withdraw your earnings."
            : `Your payout account was rejected: ${reason}. Please update it in Verification Center.`,
        data: { status },
      });

      return success(res, { _id: account._id, status: account.status, revision: account.revision }, { requestId: req.requestId });
    } catch (error) {
      return fail(res, 500, "PAYOUT_ACCOUNT_VERIFY_FAILED", "Unable to update payout account", error.message, {
        requestId: req.requestId,
      });
    }
  }
);

module.exports = router;
