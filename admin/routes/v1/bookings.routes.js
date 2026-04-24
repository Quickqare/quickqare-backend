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
