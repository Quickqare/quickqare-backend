const express = require("express");
const mongoose = require("mongoose");
const Booking = require("../../../models/Booking");
const Partner = require("../../../models/Partner");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const BookingAssignment = require("../../models/BookingAssignment");
const BookingTimeline = require("../../models/BookingTimeline");
const Refund = require("../../models/Refund");
const { PERMISSIONS } = require("../../constants/permissions");
const { asSingleString, getPagination } = require("../../utils/common");
const { success, fail } = require("../../utils/response");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.BOOKINGS_ASSIGN));

router.get("/", async (req, res) => {
  try {
    const status = String(asSingleString(req.query.status) || "").toUpperCase();
    const { page, pageSize, skip, limit } = getPagination(req);
    const where = {};
    if (status) where.status = status;

    const [rows, total] = await Promise.all([
      Booking.find(where)
        .populate("user")
        .populate("partner")
        .populate("primaryService")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Booking.countDocuments(where),
    ]);

    return success(res, rows, { requestId: req.requestId, pagination: { page, pageSize, total } });
  } catch (error) {
    return fail(res, 500, "BOOKINGS_LIST_FAILED", "Unable to fetch bookings", error.message, {
      requestId: req.requestId,
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const bookingId = asSingleString(req.params.id);
    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return fail(res, 400, "INVALID_ID", "Invalid booking id", null, { requestId: req.requestId });
    }

    const [booking, timeline, assignments, refunds] = await Promise.all([
      Booking.findById(bookingId)
        .populate("user")
        .populate("partner")
        .populate("primaryService")
        .populate("assignmentAudit.selectedPartnerId", "name phone")
        .populate("assignmentAudit.candidates.partnerId", "name phone")
        .lean(),
      BookingTimeline.find({ bookingId }).sort({ createdAt: 1 }).lean(),
      BookingAssignment.find({ bookingId }).sort({ createdAt: -1 }).lean(),
      Refund.find({ bookingId }).sort({ createdAt: -1 }).lean(),
    ]);

    if (!booking) {
      return fail(res, 404, "NOT_FOUND", "Booking not found", null, { requestId: req.requestId });
    }

    return success(
      res,
      {
        ...booking,
        timeline,
        assignments,
        refunds,
      },
      { requestId: req.requestId }
    );
  } catch (error) {
    return fail(res, 500, "BOOKING_FETCH_FAILED", "Unable to fetch booking", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post("/:id/assign", audit("admin.bookings.assign"), async (req, res) => {
  try {
    const bookingId = asSingleString(req.params.id);
    const partnerId = String(req.body.partnerId || "");
    const reason = String(req.body.reason || "");

    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return fail(res, 400, "INVALID_ID", "Invalid booking id", null, { requestId: req.requestId });
    }
    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid partnerId is required", null, {
        requestId: req.requestId,
      });
    }

    const [booking, partner] = await Promise.all([Booking.findById(bookingId), Partner.findById(partnerId)]);
    if (!booking || !partner) {
      return fail(res, 404, "NOT_FOUND", "Booking or partner not found", null, { requestId: req.requestId });
    }

    booking.partner = partner._id;
    booking.status = "ASSIGNED";
    await booking.save();

    await Promise.all([
      BookingAssignment.create({
        bookingId,
        partnerId,
        assignedByAdminId: req.adminUser.id,
        reason,
      }),
      BookingTimeline.create({
        bookingId,
        eventType: "ASSIGNED",
        payload: JSON.stringify({ partnerId, adminId: req.adminUser.id, reason }),
        createdByAdminId: req.adminUser.id,
      }),
    ]);

    return success(res, booking, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "BOOKING_ASSIGN_FAILED", "Unable to assign booking", error.message, {
      requestId: req.requestId,
    });
  }
});

// POST /:id/reassign — force-reassign a booking to a different partner, with full safeguards
router.post("/:id/reassign", audit("admin.bookings.reassign"), async (req, res) => {
  try {
    const bookingId = asSingleString(req.params.id);
    const partnerId = String(req.body.partnerId || "");
    const reason = String(req.body.reason || "").trim();

    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return fail(res, 400, "INVALID_ID", "Invalid booking id", null, { requestId: req.requestId });
    }
    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid partnerId is required", null, { requestId: req.requestId });
    }
    if (!reason || reason.length < 3) {
      return fail(res, 400, "VALIDATION_ERROR", "reason must be at least 3 characters", null, { requestId: req.requestId });
    }

    const [booking, newPartner] = await Promise.all([
      Booking.findById(bookingId),
      Partner.findById(partnerId),
    ]);

    if (!booking) return fail(res, 404, "NOT_FOUND", "Booking not found", null, { requestId: req.requestId });
    if (!newPartner) return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });

    // Safeguard: partner must be active and approved
    if (newPartner.approvalStatus !== "APPROVED" || newPartner.isBlocked) {
      return fail(res, 400, "PARTNER_NOT_ELIGIBLE", "Partner is not approved or is blocked", null, { requestId: req.requestId });
    }

    // Safeguard: no overloading — partner must be below job limit
    if (newPartner.activeJobs >= newPartner.maxJobsLimit) {
      return fail(res, 400, "PARTNER_OVERLOADED",
        `Partner already has ${newPartner.activeJobs}/${newPartner.maxJobsLimit} active jobs. Cannot assign more.`,
        null, { requestId: req.requestId });
    }

    // Safeguard: booking must be in a reassignable state
    const REASSIGNABLE = ["PENDING_ASSIGNMENT", "QUEUED", "SEARCHING", "ASSIGNED", "CONFIRMED",
      "PARTNER_ACCEPTED", "ON_THE_WAY", "ARRIVED", "NO_PARTNER_AVAILABLE"];
    if (!REASSIGNABLE.includes(booking.status)) {
      return fail(res, 400, "NOT_REASSIGNABLE",
        `Booking in status "${booking.status}" cannot be reassigned`, null, { requestId: req.requestId });
    }

    // Safeguard: can't reassign to the same partner
    if (booking.partner && String(booking.partner) === String(newPartner._id)) {
      return fail(res, 400, "SAME_PARTNER", "Booking is already assigned to this partner", null, { requestId: req.requestId });
    }

    // Release old partner's active job slot
    const oldPartnerId = booking.partner;
    if (oldPartnerId) {
      await Partner.findByIdAndUpdate(oldPartnerId, { $inc: { activeJobs: -1 } });
    }

    // Assign to new partner and record in audit log
    booking.partner = newPartner._id;
    booking.status = "ASSIGNED";
    if (Array.isArray(booking.assignmentAudit)) {
      booking.assignmentAudit.push({
        stage: booking.assignmentStage || 1,
        event: "admin_force_reassign",
        selectedPartnerId: newPartner._id,
        notes: `Force-reassigned by admin (${req.adminUser?.email || req.adminUser?.id}). Reason: ${reason}`,
      });
    }
    await booking.save();

    // Give new partner the job slot
    await Partner.findByIdAndUpdate(newPartner._id, {
      $inc: { activeJobs: 1 },
      $set: { lastAssignedAt: new Date() },
    });

    // Persist in BookingAssignment + Timeline
    await Promise.all([
      BookingAssignment.create({
        bookingId,
        partnerId,
        assignedByAdminId: req.adminUser.id,
        reason: `REASSIGN: ${reason}`,
      }),
      BookingTimeline.create({
        bookingId,
        eventType: "REASSIGNED",
        payload: JSON.stringify({
          oldPartnerId: oldPartnerId || null,
          newPartnerId: partnerId,
          adminId: req.adminUser.id,
          reason,
        }),
        createdByAdminId: req.adminUser.id,
      }),
    ]);

    // Notify new partner over socket if connected
    if (global.io) {
      global.io.to(`partner_${newPartner._id}`).emit("booking_assigned", {
        bookingId: booking._id,
        bookingNumber: booking.bookingNumber,
      });
    }

    return success(res, {
      bookingId: booking._id,
      status: booking.status,
      newPartnerId: newPartner._id,
      newPartnerName: newPartner.name,
    }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "BOOKING_REASSIGN_FAILED", "Unable to reassign booking", error.message, { requestId: req.requestId });
  }
});

router.post("/:id/cancel", audit("admin.bookings.cancel"), async (req, res) => {
  try {
    const bookingId = asSingleString(req.params.id);
    const reason = String(req.body.reason || "");
    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return fail(res, 400, "INVALID_ID", "Invalid booking id", null, { requestId: req.requestId });
    }
    if (!reason || reason.length < 3) {
      return fail(res, 400, "VALIDATION_ERROR", "reason must be at least 3 characters", null, {
        requestId: req.requestId,
      });
    }

    const booking = await Booking.findByIdAndUpdate(
      bookingId,
      { $set: { status: "CANCELLED" } },
      { new: true }
    ).lean();
    if (!booking) {
      return fail(res, 404, "NOT_FOUND", "Booking not found", null, { requestId: req.requestId });
    }

    await BookingTimeline.create({
      bookingId,
      eventType: "CANCELLED",
      payload: JSON.stringify({ reason, adminId: req.adminUser.id }),
      createdByAdminId: req.adminUser.id,
    });

    return success(res, booking, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "BOOKING_CANCEL_FAILED", "Unable to cancel booking", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post(
  "/:id/refund",
  authorize(PERMISSIONS.PAYMENTS_REFUND),
  audit("admin.bookings.refund"),
  async (req, res) => {
    try {
      const bookingId = asSingleString(req.params.id);
      const amountInr = Number(req.body.amountInr);
      const reason = String(req.body.reason || "");

      if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
        return fail(res, 400, "INVALID_ID", "Invalid booking id", null, { requestId: req.requestId });
      }
      if (!Number.isFinite(amountInr) || amountInr < 1 || reason.length < 3) {
        return fail(res, 400, "VALIDATION_ERROR", "amountInr and reason are required", null, {
          requestId: req.requestId,
        });
      }

      const booking = await Booking.findById(bookingId).lean();
      if (!booking) {
        return fail(res, 404, "NOT_FOUND", "Booking not found", null, { requestId: req.requestId });
      }

      const refund = await Refund.create({
        bookingId,
        amountInr,
        reason,
        status: "REQUESTED",
        requestedByAdminId: req.adminUser.id,
      });

      await BookingTimeline.create({
        bookingId,
        eventType: "REFUND_REQUESTED",
        payload: JSON.stringify({ refundId: refund._id, amountInr }),
        createdByAdminId: req.adminUser.id,
      });

      return success(res, refund, { requestId: req.requestId });
    } catch (error) {
      return fail(res, 500, "BOOKING_REFUND_FAILED", "Unable to request refund", error.message, {
        requestId: req.requestId,
      });
    }
  }
);

module.exports = router;
