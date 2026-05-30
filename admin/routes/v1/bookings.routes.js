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

    const { start, end } = req.query;
    if (start || end) {
      where.createdAt = {};
      if (start) { const s = new Date(start); if (!isNaN(s)) where.createdAt.$gte = s; }
      if (end)   { const e = new Date(end);   if (!isNaN(e)) where.createdAt.$lte = e; }
      if (!Object.keys(where.createdAt).length) delete where.createdAt;
    }

    const q = String(asSingleString(req.query.q) || "").trim();
    if (q) {
      // Search by booking ID (exact), customer phone, or customer name
      const isObjectId = mongoose.Types.ObjectId.isValid(q);
      const userMatches = await require("../../../models/User")
        .find({ $or: [{ phone: { $regex: q, $options: "i" } }, { name: { $regex: q, $options: "i" } }] })
        .select("_id").lean();
      const userIds = userMatches.map((u) => u._id);
      const orClauses = [{ user: { $in: userIds } }];
      if (isObjectId) orClauses.push({ _id: new mongoose.Types.ObjectId(q) });
      where.$or = orClauses;
    }

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

// POST /:id/force-cancel — admin hard-cancel from any non-terminal status
// Distinct from /:id/cancel (which is a soft cancel that doesn't free the
// partner or emit sockets). Force-cancel handles partner release, socket
// notifications, and ack-timeout cleanup in one shot.
router.post("/:id/force-cancel", audit("admin.bookings.force_cancel"), async (req, res) => {
  try {
    const bookingId = asSingleString(req.params.id);
    const reason = String(req.body.reason || "").trim();

    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return fail(res, 400, "INVALID_ID", "Invalid booking id", null, { requestId: req.requestId });
    }
    if (!reason || reason.length < 3) {
      return fail(res, 400, "VALIDATION_ERROR", "reason must be at least 3 characters", null, { requestId: req.requestId });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return fail(res, 404, "NOT_FOUND", "Booking not found", null, { requestId: req.requestId });
    }

    if (booking.status === "CANCELLED") {
      return fail(res, 409, "ALREADY_CANCELLED", "Booking is already cancelled", null, { requestId: req.requestId });
    }
    if (booking.status === "COMPLETED") {
      return fail(res, 409, "ALREADY_COMPLETED", "Completed bookings cannot be force-cancelled", null, { requestId: req.requestId });
    }

    const assignedPartnerId = booking.partner;

    // Atomically flip to CANCELLED so concurrent requests are safe
    const updated = await Booking.findOneAndUpdate(
      { _id: bookingId, status: { $nin: ["CANCELLED", "COMPLETED"] } },
      {
        $set: {
          status: "CANCELLED",
          cancelledBy: "admin",
          cancelReason: reason,
        },
      },
      { new: true }
    );

    if (!updated) {
      // Race: another request already cancelled or completed it
      return fail(res, 409, "STATUS_CONFLICT", "Booking status changed concurrently — refresh and try again", null, { requestId: req.requestId });
    }

    // Release partner's active job slot
    if (assignedPartnerId) {
      await Partner.findByIdAndUpdate(assignedPartnerId, {
        $inc: { activeJobs: -1 },
      });
    }

    // Cancel any pending ACK timeout so it doesn't fire after cancellation
    try {
      const { cancelAckTimeout } = require("../../../services/ackTimeout.service");
      await cancelAckTimeout(bookingId);
    } catch (_) { /* non-fatal */ }

    // Release slot capacity if still held
    try {
      const { releaseSlotCapacityByBookingId } = require("../../../services/slotCapacity.service");
      await releaseSlotCapacityByBookingId(booking._id, { releaseReason: "admin_force_cancel" });
    } catch (_) { /* non-fatal */ }

    // Notify customer and partner via socket
    if (global.io) {
      global.io.to(`user_${updated.user}`).emit("booking_update", {
        bookingId: updated._id.toString(),
        status: "CANCELLED",
        cancelReason: reason,
      });
      if (assignedPartnerId) {
        global.io.to(`partner_${assignedPartnerId}`).emit("booking_cancelled", {
          bookingId: updated._id.toString(),
        });
      }
    }

    await BookingTimeline.create({
      bookingId,
      eventType: "FORCE_CANCELLED",
      payload: JSON.stringify({ reason, adminId: req.adminUser.id, adminEmail: req.adminUser.email }),
      createdByAdminId: req.adminUser.id,
    });

    return success(res, { bookingId: updated._id, status: "CANCELLED" }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "BOOKING_FORCE_CANCEL_FAILED", "Unable to force-cancel booking", error.message, { requestId: req.requestId });
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

// POST /:id/request-reschedule — admin manually flags a booking for rescheduling
router.post("/:id/request-reschedule", audit("admin.bookings.request_reschedule"), async (req, res) => {
  try {
    const bookingId = asSingleString(req.params.id);
    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return fail(res, 400, "INVALID_ID", "Invalid booking id", null, { requestId: req.requestId });
    }

    const VALID_REASONS = [
      "Due to an unforeseen emergency with your assigned professional",
      "Due to a scheduling conflict on our end",
      "Due to adverse weather conditions in your area",
      "Due to a technical issue with our operations",
      "Due to high service demand in your area",
    ];

    const reason = String(req.body.reason || "").trim();
    if (!VALID_REASONS.includes(reason)) {
      return fail(res, 400, "INVALID_REASON", "Please select a valid reason", null, { requestId: req.requestId });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return fail(res, 404, "NOT_FOUND", "Booking not found", null, { requestId: req.requestId });
    }

    const ELIGIBLE = ["PARTNER_ACCEPTED", "ON_THE_WAY", "ARRIVED", "ASSIGNED", "CONFIRMED", "SEARCHING"];
    if (!ELIGIBLE.includes(booking.status)) {
      return fail(res, 400, "NOT_ELIGIBLE",
        `Cannot request reschedule for a booking in "${booking.status}" status`, null, { requestId: req.requestId });
    }

    booking.status = "NEEDS_RESCHEDULING";
    booking.rescheduleReason = reason;
    booking.rescheduleRequestedAt = new Date();
    await booking.save();

    // Notify customer
    if (global.io) {
      global.io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: booking._id.toString(),
        status: "NEEDS_RESCHEDULING",
        rescheduleReason: reason,
      });
    }

    const { notifyCustomerOfBookingStatus } = require("../../../services/pushNotification.service");
    notifyCustomerOfBookingStatus(booking.user, "NEEDS_RESCHEDULING", booking._id);

    await BookingTimeline.create({
      bookingId,
      eventType: "RESCHEDULE_REQUESTED",
      payload: JSON.stringify({ reason, adminId: req.adminUser.id }),
      createdByAdminId: req.adminUser.id,
    });

    return success(res, { bookingId: booking._id, status: "NEEDS_RESCHEDULING" }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "RESCHEDULE_REQUEST_FAILED", "Unable to request reschedule", error.message, { requestId: req.requestId });
  }
});

module.exports = router;
