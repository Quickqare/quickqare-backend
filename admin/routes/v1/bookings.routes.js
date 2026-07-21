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
const { asSingleString, getPagination, escapeRegex } = require("../../utils/common");
const { success, fail } = require("../../utils/response");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.BOOKINGS_ASSIGN));

// Booking statuses from which an admin may (re)assign a partner. Excludes
// terminal states (COMPLETED / CANCELLED) and PENDING_PAYMENT so a manual
// assign can never resurrect a finished or unpaid booking.
const ASSIGNABLE_STATES = [
  "PENDING_ASSIGNMENT", "QUEUED", "SEARCHING", "ASSIGNED", "CONFIRMED",
  "PARTNER_ACCEPTED", "ON_THE_WAY", "ARRIVED", "NO_PARTNER_AVAILABLE",
];

// Notify a partner that a job has been (re)assigned to them. Emits the exact
// socket events the partner app listens for (jobAssigned / job_assigned — see
// mobile/src/services/socket.ts), with a full job payload, plus a push for
// backgrounded apps. Best-effort: never throws into the request flow.
// Tell a partner their job was taken away (admin cancel / reassign). Without
// this, a force-reassigned partner's app kept showing the job — they could
// still show up at the customer's door. Socket for the open app, push for a
// backgrounded one. Best-effort: never throws into the request flow.
async function notifyPartnerOfRemoval(partnerId, bookingId, reason) {
  try {
    if (!partnerId) return;
    if (global.io) {
      // "job_cancelled" is the event the partner app actually handles.
      global.io.to(`partner_${partnerId}`).emit("job_cancelled", {
        bookingId: String(bookingId),
        cancelledBy: "admin",
        reason: reason || "Reassigned by support",
      });
    }
    const removed = await Partner.findById(partnerId).select("fcmToken").lean();
    if (removed?.fcmToken) {
      const { sendJobCancelledPush } = require("../../../services/pushNotification.service");
      sendJobCancelledPush(removed.fcmToken, String(bookingId));
    }
  } catch (err) {
    console.error("notifyPartnerOfRemoval error:", err.message);
  }
}

async function notifyPartnerOfAssignment(booking, partner) {
  try {
    await booking.populate([
      { path: "user", select: "name phone" },
      { path: "primaryService", select: "name" },
    ]);
    const payload = {
      bookingId: booking._id.toString(),
      _id: booking._id.toString(),
      serviceName: booking.primaryService?.name || booking.serviceCategory || "Service",
      serviceCategory: booking.serviceCategory || undefined,
      customerName: booking.user?.name || "Customer",
      customerPhone: booking.user?.phone || "",
      address: booking.address || "",
      pincode: booking.pincode || undefined,
      location: booking.location || undefined,
      scheduledDate: booking.scheduledDate || undefined,
      scheduledTime: booking.scheduledTime || undefined,
      totalAmount: booking.totalAmount || 0,
      amount: booking.totalAmount || 0,
      price: booking.totalAmount || 0,
      status: "ASSIGNED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (global.io) {
      global.io.to(`partner_${partner._id}`).emit("jobAssigned", payload);
      global.io.to(`partner_${partner._id}`).emit("job_assigned", payload);
    }
    if (partner.fcmToken) {
      const { sendJobAssignedPush } = require("../../../services/pushNotification.service");
      sendJobAssignedPush(partner.fcmToken, String(booking._id));
    }
  } catch (err) {
    console.error("notifyPartnerOfAssignment error:", err.message);
  }
}

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
      const qSafe = escapeRegex(q);
      const userMatches = await require("../../../models/User")
        .find({ $or: [{ phone: { $regex: qSafe, $options: "i" } }, { name: { $regex: qSafe, $options: "i" } }] })
        .select("_id").lean();
      const userIds = userMatches.map((u) => u._id);
      const orClauses = [{ user: { $in: userIds } }];
      if (isObjectId) orClauses.push({ _id: new mongoose.Types.ObjectId(q) });
      where.$or = orClauses;
    }

    const [rows, total] = await Promise.all([
      Booking.find(where)
        // Field-projected populates — the list view only needs identity/summary
        // fields, not the full user/partner documents (which include large or
        // sensitive nested data). Lighter payloads + less data exposure.
        .populate("user", "name phone email")
        .populate("partner", "name phone approvalStatus rating selfieUrl")
        .populate("primaryService", "name imageUrl duration price")
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
        .populate("partnerReports.partner", "name phone")
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
    if (!booking) {
      return fail(res, 404, "NOT_FOUND", "Booking not found", null, { requestId: req.requestId });
    }
    if (!partner) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    // Safeguard: partner must be active and approved
    if (partner.approvalStatus !== "APPROVED" || partner.isBlocked) {
      return fail(res, 400, "PARTNER_NOT_ELIGIBLE", "Partner is not approved or is blocked", null, { requestId: req.requestId });
    }

    // Safeguard: no overloading — partner must be below job limit
    if (partner.activeJobs >= partner.maxJobsLimit) {
      return fail(res, 400, "PARTNER_OVERLOADED",
        `Partner already has ${partner.activeJobs}/${partner.maxJobsLimit} active jobs. Cannot assign more.`,
        null, { requestId: req.requestId });
    }

    // Safeguard: booking must be in an assignable state — never resurrect a
    // COMPLETED / CANCELLED / unpaid booking by assigning a partner to it.
    if (!ASSIGNABLE_STATES.includes(booking.status)) {
      return fail(res, 400, "NOT_ASSIGNABLE",
        `Booking in status "${booking.status}" cannot be assigned`, null, { requestId: req.requestId });
    }

    // Safeguard: can't assign to the partner who already holds the booking
    if (booking.partner && String(booking.partner) === String(partner._id)) {
      return fail(res, 400, "SAME_PARTNER", "Booking is already assigned to this partner", null, { requestId: req.requestId });
    }

    const previousPartnerId = booking.partner;
    const previousAdditional = (booking.additionalPartners || []).map(String);

    // GUARDED atomic assignment (not a full-doc save): a concurrent transition
    // (cancel, partner accept, engine assign) must not be overwritten.
    //
    // assignedAt anchors the advance-ACK deadline cron for the NEW partner;
    // ackReceivedAt is reset so a previous partner's acknowledgement can't
    // satisfy the new one's ACK gate — previously a manually assigned partner
    // who ignored the job was never auto-reassigned. Manual assignment is
    // single-partner, so stale team state is cleared too.
    const assigned = await Booking.findOneAndUpdate(
      { _id: booking._id, status: { $in: ASSIGNABLE_STATES } },
      {
        $set: {
          partner: partner._id,
          status: "ASSIGNED",
          assignedAt: new Date(),
          ackReceivedAt: null,
          additionalPartners: [],
          teamAllocations: [],
        },
        $push: {
          assignmentAudit: {
            stage: booking.assignmentStage || 1,
            event: "admin_manual_assign",
            selectedPartnerId: partner._id,
            notes: `Manually assigned by admin (${req.adminUser?.email || req.adminUser?.id})${reason ? `. Reason: ${reason}` : ""}`,
          },
        },
      },
      { new: true }
    );
    if (!assigned) {
      return fail(res, 409, "STATUS_CONFLICT", "Booking status changed concurrently — refresh and try again", null, { requestId: req.requestId });
    }

    // activeJobs / busySlots are derived from committed bookings — recompute them
    // for every affected partner instead of hand-incrementing (which drifts).
    try {
      const { syncPartnerOperationalState } = require("../../../services/scheduling_service");
      for (const pid of new Set([String(previousPartnerId || ""), ...previousAdditional].filter(Boolean))) {
        if (pid !== String(partner._id)) await syncPartnerOperationalState(pid);
      }
      await syncPartnerOperationalState(partner._id);
    } catch (syncErr) {
      console.error("assign syncPartnerOperationalState error:", syncErr.message);
    }

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

    // Displaced partner must learn the job is no longer theirs.
    if (previousPartnerId && String(previousPartnerId) !== String(partner._id)) {
      await notifyPartnerOfRemoval(previousPartnerId, bookingId, reason);
    }
    for (const pid of previousAdditional) {
      await notifyPartnerOfRemoval(pid, bookingId, reason);
    }

    // Customer sees the assignment immediately instead of a stale SEARCHING /
    // NO_PARTNER_AVAILABLE screen.
    if (global.io) {
      global.io.to(`user_${assigned.user}`).emit("booking_update", {
        bookingId: String(assigned._id),
        status: "ASSIGNED",
      });
    }

    // Notify the assigned partner in real time + push. The old handler emitted
    // nothing, so manually-assigned partners only saw the job on a manual refresh.
    await notifyPartnerOfAssignment(assigned, partner);

    return success(res, assigned, { requestId: req.requestId });
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
    if (!ASSIGNABLE_STATES.includes(booking.status)) {
      return fail(res, 400, "NOT_REASSIGNABLE",
        `Booking in status "${booking.status}" cannot be reassigned`, null, { requestId: req.requestId });
    }

    // Safeguard: can't reassign to the same partner
    if (booking.partner && String(booking.partner) === String(newPartner._id)) {
      return fail(res, 400, "SAME_PARTNER", "Booking is already assigned to this partner", null, { requestId: req.requestId });
    }

    const oldPartnerId = booking.partner;
    const oldAdditional = (booking.additionalPartners || []).map(String);

    // GUARDED atomic reassignment — same shape as /assign. The old partner
    // goes onto rejectedPartners so the auto-engine can never hand this
    // booking back to them; assignedAt/ackReceivedAt give the NEW partner a
    // fresh ACK window; stale team state is cleared.
    const reassigned = await Booking.findOneAndUpdate(
      { _id: booking._id, status: { $in: ASSIGNABLE_STATES } },
      {
        $set: {
          partner: newPartner._id,
          status: "ASSIGNED",
          assignedAt: new Date(),
          ackReceivedAt: null,
          additionalPartners: [],
          teamAllocations: [],
        },
        ...(oldPartnerId ? { $addToSet: { rejectedPartners: oldPartnerId } } : {}),
        $push: {
          assignmentAudit: {
            stage: booking.assignmentStage || 1,
            event: "admin_force_reassign",
            selectedPartnerId: newPartner._id,
            notes: `Force-reassigned by admin (${req.adminUser?.email || req.adminUser?.id}). Reason: ${reason}`,
          },
        },
      },
      { new: true }
    );
    if (!reassigned) {
      return fail(res, 409, "STATUS_CONFLICT", "Booking status changed concurrently — refresh and try again", null, { requestId: req.requestId });
    }

    // Recompute activeJobs/busySlots from committed bookings for everyone
    // touched — the old raw $inc could drive activeJobs negative for a partner
    // who had never accepted, permanently skewing their load score.
    try {
      const { syncPartnerOperationalState } = require("../../../services/scheduling_service");
      for (const pid of new Set([String(oldPartnerId || ""), ...oldAdditional].filter(Boolean))) {
        await syncPartnerOperationalState(pid);
      }
      await syncPartnerOperationalState(newPartner._id);
    } catch (syncErr) {
      console.error("reassign syncPartnerOperationalState error:", syncErr.message);
    }
    await Partner.updateOne({ _id: newPartner._id }, { $set: { lastAssignedAt: new Date() } });

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

    // The DISPLACED partner must learn the job is gone — previously only the
    // new partner was notified, so the old one's app kept showing the job and
    // they could still show up at the customer's door.
    if (oldPartnerId) await notifyPartnerOfRemoval(oldPartnerId, bookingId, reason);
    for (const pid of oldAdditional) {
      await notifyPartnerOfRemoval(pid, bookingId, reason);
    }

    if (global.io) {
      global.io.to(`user_${reassigned.user}`).emit("booking_update", {
        bookingId: String(reassigned._id),
        status: "ASSIGNED",
      });
    }

    // Notify the new partner — uses the events the partner app actually listens
    // for (jobAssigned / job_assigned), with a full job payload + push. The old
    // "booking_assigned" event was never handled by the app, so reassigned
    // partners were never alerted in real time.
    await notifyPartnerOfAssignment(reassigned, newPartner);

    return success(res, {
      bookingId: reassigned._id,
      status: reassigned.status,
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

    // Guard against re-transitioning a terminal booking — a COMPLETED job must not be
    // flipped to CANCELLED (it corrupts reporting and implies a refund on delivered work).
    // cancelledBy/cancelledAt/cancelReason are recorded so the cancel is attributable —
    // previously this route set the status only.
    const booking = await Booking.findOneAndUpdate(
      { _id: bookingId, status: { $nin: ["CANCELLED", "COMPLETED"] } },
      {
        $set: {
          status: "CANCELLED",
          cancelledBy: "admin",
          cancelledAt: new Date(),
          cancelReason: reason,
        },
      },
      { new: true }
    ).lean();
    if (!booking) {
      const exists = await Booking.exists({ _id: bookingId });
      if (!exists) {
        return fail(res, 404, "NOT_FOUND", "Booking not found", null, { requestId: req.requestId });
      }
      return fail(res, 409, "ALREADY_TERMINAL", "Booking is already completed or cancelled", null, { requestId: req.requestId });
    }

    // Full cleanup — previously this "soft" cancel released nothing: the slot's
    // reserved capacity stayed consumed FOREVER (no other path releases a
    // cancelled booking's lock), the ACK timer could still fire, the partner's
    // calendar stayed blocked, and neither side was told.
    try {
      const { releaseSlotCapacityByBookingId } = require("../../../services/slotCapacity.service");
      await releaseSlotCapacityByBookingId(booking._id, { releaseReason: "admin_cancel" });
    } catch (_) { /* non-fatal */ }
    try {
      const { cancelAckTimeout } = require("../../../services/ackTimeout.service");
      await cancelAckTimeout(bookingId);
    } catch (_) { /* non-fatal */ }
    try {
      const { syncPartnerOperationalState } = require("../../../services/scheduling_service");
      for (const pid of [booking.partner, ...(booking.additionalPartners || [])].filter(Boolean)) {
        await syncPartnerOperationalState(pid);
      }
    } catch (syncErr) {
      console.error("cancel syncPartnerOperationalState error:", syncErr.message);
    }

    if (global.io) {
      global.io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: String(booking._id),
        status: "CANCELLED",
        cancelledBy: "admin",
        cancelReason: reason,
      });
    }
    for (const pid of [booking.partner, ...(booking.additionalPartners || [])].filter(Boolean)) {
      await notifyPartnerOfRemoval(pid, bookingId, reason);
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

    // Release every attached partner's calendar — recomputed from committed
    // bookings (the old raw $inc could drive activeJobs negative for a partner
    // who had never accepted).
    const teamPartnerIds = [assignedPartnerId, ...(booking.additionalPartners || [])].filter(Boolean);
    try {
      const { syncPartnerOperationalState } = require("../../../services/scheduling_service");
      for (const pid of teamPartnerIds) {
        await syncPartnerOperationalState(pid);
      }
    } catch (syncErr) {
      console.error("force-cancel syncPartnerOperationalState error:", syncErr.message);
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

    // Notify customer and the whole partner team (socket + push).
    if (global.io) {
      global.io.to(`user_${updated.user}`).emit("booking_update", {
        bookingId: updated._id.toString(),
        status: "CANCELLED",
        cancelReason: reason,
      });
    }
    for (const pid of teamPartnerIds) {
      await notifyPartnerOfRemoval(pid, bookingId, reason);
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

      // Keep the booking's own refund flags in sync with this admin refund so the two
      // systems aren't disjoint (previously the booking's refundStatus was never touched
      // by the admin refund flow, leaving "is the money back?" with no source of truth).
      await Booking.findByIdAndUpdate(bookingId, {
        $set: {
          refundStatus: "PENDING",
          ...(Number(booking.refundAmount) > 0 ? {} : { refundAmount: amountInr }),
        },
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

// POST /:id/refund/:refundId/complete — mark a requested refund as actually paid out.
// This is the previously-missing reconciliation step: it transitions the Refund doc
// REQUESTED → COMPLETED AND syncs the booking's refundStatus → PROCESSED, so the two
// systems agree on whether the customer's money was returned.
router.post(
  "/:id/refund/:refundId/complete",
  authorize(PERMISSIONS.PAYMENTS_REFUND),
  audit("admin.bookings.refund_complete"),
  async (req, res) => {
    try {
      const bookingId = asSingleString(req.params.id);
      const refundId = asSingleString(req.params.refundId);
      if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId) ||
          !refundId || !mongoose.Types.ObjectId.isValid(refundId)) {
        return fail(res, 400, "INVALID_ID", "Invalid id", null, { requestId: req.requestId });
      }

      // Idempotent: only a still-REQUESTED refund can be completed.
      const refund = await Refund.findOneAndUpdate(
        { _id: refundId, bookingId, status: "REQUESTED" },
        { $set: { status: "COMPLETED", processedAt: new Date() } },
        { new: true }
      );
      if (!refund) {
        const exists = await Refund.exists({ _id: refundId, bookingId });
        if (!exists) return fail(res, 404, "NOT_FOUND", "Refund not found", null, { requestId: req.requestId });
        return fail(res, 409, "ALREADY_PROCESSED", "Refund already processed", null, { requestId: req.requestId });
      }

      await Booking.findByIdAndUpdate(bookingId, {
        $set: { refundStatus: "PROCESSED", refundProcessedAt: new Date() },
      });

      await BookingTimeline.create({
        bookingId,
        eventType: "REFUND_COMPLETED",
        payload: JSON.stringify({ refundId: refund._id, amountInr: refund.amountInr }),
        createdByAdminId: req.adminUser.id,
      });

      return success(res, refund, { requestId: req.requestId });
    } catch (error) {
      return fail(res, 500, "REFUND_COMPLETE_FAILED", "Unable to complete refund", error.message, {
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
