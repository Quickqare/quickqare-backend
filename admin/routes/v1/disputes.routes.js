const express = require("express");
const mongoose = require("mongoose");
const Dispute = require("../../models/Dispute");
const BookingTimeline = require("../../models/BookingTimeline");
const { recordRefundOwed } = require("../../services/refund.service");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { asSingleString, getPagination } = require("../../utils/common");
const { success, fail } = require("../../utils/response");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.DISPUTES_RESOLVE));

router.get("/", async (req, res) => {
  try {
    const { page, pageSize, skip, limit } = getPagination(req);
    const [rows, total] = await Promise.all([
      Dispute.find()
        .populate("bookingId")
        .populate("customerId", "name phone email")
        .populate("partnerId", "name phone")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Dispute.countDocuments(),
    ]);

    return success(res, rows, { requestId: req.requestId, pagination: { page, pageSize, total } });
  } catch (error) {
    return fail(res, 500, "DISPUTES_LIST_FAILED", "Unable to fetch disputes", error.message, {
      requestId: req.requestId,
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const disputeId = asSingleString(req.params.id);
    if (!disputeId || !mongoose.Types.ObjectId.isValid(disputeId)) {
      return fail(res, 400, "INVALID_ID", "Invalid dispute id", null, { requestId: req.requestId });
    }

    const row = await Dispute.findById(disputeId)
      .populate("bookingId")
      .populate("customerId", "name phone email")
      .populate("partnerId", "name phone")
      .lean();
    if (!row) {
      return fail(res, 404, "NOT_FOUND", "Dispute not found", null, { requestId: req.requestId });
    }

    return success(res, row, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "DISPUTE_FETCH_FAILED", "Unable to fetch dispute", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post("/:id/resolve", audit("admin.disputes.resolve"), async (req, res) => {
  try {
    const disputeId = asSingleString(req.params.id);
    const resolution = String(req.body.resolution || "").toUpperCase();
    const notes = String(req.body.notes || "");
    const refundAmountInr = Number(req.body.refundAmountInr || 0);

    if (!disputeId || !mongoose.Types.ObjectId.isValid(disputeId)) {
      return fail(res, 400, "INVALID_ID", "Invalid dispute id", null, { requestId: req.requestId });
    }
    if (!["REFUND", "PENALTY", "NO_ACTION"].includes(resolution)) {
      return fail(res, 400, "VALIDATION_ERROR", "resolution must be REFUND, PENALTY or NO_ACTION", null, {
        requestId: req.requestId,
      });
    }

    if (!Number.isFinite(refundAmountInr) || refundAmountInr < 0) {
      return fail(res, 400, "VALIDATION_ERROR", "Refund amount must be zero or more", null, {
        requestId: req.requestId,
      });
    }

    // Claim first: only the request that takes the dispute out of an open
    // state resolves it. Resolving used to be a plain save, so a second click
    // (or a second admin) resolved it again and added another refund.
    // `new: false` hands back the dispute as it was, in case the refund below
    // is refused and the claim has to be undone.
    const previous = await Dispute.findOneAndUpdate(
      { _id: disputeId, status: { $ne: "RESOLVED" } },
      {
        $set: {
          status: "RESOLVED",
          resolution,
          resolvedByAdminId: req.adminUser.id,
          resolvedAt: new Date(),
        },
        $push: {
          events: {
            eventType: "RESOLVED",
            payload: JSON.stringify({ resolution, notes, refundAmountInr }),
            createdByAdminId: req.adminUser.id,
            createdAt: new Date(),
          },
        },
      },
      { new: false }
    ).lean();
    if (!previous) {
      const exists = await Dispute.exists({ _id: disputeId });
      return exists
        ? fail(res, 409, "ALREADY_RESOLVED", "This dispute is already resolved", null, { requestId: req.requestId })
        : fail(res, 404, "NOT_FOUND", "Dispute not found", null, { requestId: req.requestId });
    }

    // The refund goes on the booking through the shared service: capped at
    // what the customer paid, and listed in Payments → Customer Refunds. It
    // used to be a loose Refund record that nothing ever showed to finance.
    let refund = null;
    if (resolution === "REFUND" && refundAmountInr > 0) {
      const result = await recordRefundOwed({
        bookingId: previous.bookingId,
        amountInr: refundAmountInr,
        reason: notes || "Dispute resolution refund",
        adminId: req.adminUser.id,
      });
      if (result.error) {
        // Nothing was resolved: put the dispute back exactly as it was.
        await Dispute.updateOne(
          { _id: disputeId },
          {
            $set: {
              status: previous.status,
              resolution: previous.resolution,
              resolvedByAdminId: previous.resolvedByAdminId,
              resolvedAt: previous.resolvedAt,
            },
            $pop: { events: 1 },
          }
        );
        return fail(res, result.error.status, result.error.code, result.error.message, null, {
          requestId: req.requestId,
        });
      }
      refund = result.refund;
    }

    await BookingTimeline.create({
      bookingId: previous.bookingId,
      eventType: "DISPUTE_RESOLVED",
      payload: JSON.stringify({ disputeId, resolution, refundId: refund?._id || null }),
      createdByAdminId: req.adminUser.id,
    });

    const dispute = await Dispute.findById(disputeId).lean();
    return success(res, { dispute, refund }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "DISPUTE_RESOLVE_FAILED", "Unable to resolve dispute", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
