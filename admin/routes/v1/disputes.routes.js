const express = require("express");
const mongoose = require("mongoose");
const Dispute = require("../../models/Dispute");
const Refund = require("../../models/Refund");
const BookingTimeline = require("../../models/BookingTimeline");
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

    const dispute = await Dispute.findById(disputeId);
    if (!dispute) {
      return fail(res, 404, "NOT_FOUND", "Dispute not found", null, { requestId: req.requestId });
    }

    dispute.status = "RESOLVED";
    dispute.resolution = resolution;
    dispute.resolvedByAdminId = req.adminUser.id;
    dispute.resolvedAt = new Date();
    dispute.events.push({
      eventType: "RESOLVED",
      payload: JSON.stringify({ resolution, notes, refundAmountInr }),
      createdByAdminId: req.adminUser.id,
      createdAt: new Date(),
    });
    await dispute.save();

    let refund = null;
    if (resolution === "REFUND" && refundAmountInr > 0) {
      refund = await Refund.create({
        bookingId: dispute.bookingId,
        amountInr: refundAmountInr,
        reason: notes || "Dispute resolution refund",
        status: "REQUESTED",
        requestedByAdminId: req.adminUser.id,
      });
    }

    await BookingTimeline.create({
      bookingId: dispute.bookingId,
      eventType: "DISPUTE_RESOLVED",
      payload: JSON.stringify({ disputeId, resolution, refundId: refund?._id || null }),
      createdByAdminId: req.adminUser.id,
    });

    return success(res, { dispute, refund }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "DISPUTE_RESOLVE_FAILED", "Unable to resolve dispute", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
