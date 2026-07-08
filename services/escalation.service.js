/**
 * =====================================================
 * BOOKING ESCALATION SERVICE
 *
 * Called by the assignment engine when:
 *   - All 3 stages exhaust without a valid partner
 *   - Reassignment cap is reached
 *   - The service window has already passed
 *
 * Currently logs to console + emits to the ops socket room.
 * A future iteration can add: WhatsApp/SMS to customer,
 * Slack alert to ops, and free-reschedule offers.
 * =====================================================
 */

const Booking = require("../models/Booking");

async function escalateUnassignedBooking(bookingId) {
  try {
    const booking = await Booking.findById(bookingId)
      .select("user pincode totalAmount status scheduledDate scheduledTime autoRefundIfUnassigned payment")
      .lean();

    if (!booking) {
      console.warn(`[escalation] Booking ${bookingId} not found — nothing to escalate`);
      return { escalated: false, reason: "not_found" };
    }

    // A partner cancelled a job we were re-searching for and reassignment exhausted —
    // auto-cancel and (if the customer actually paid) issue a full refund. This flag is
    // set ONLY by the partner-cancel path and is cleared by a customer reschedule, so a
    // rescheduled or simply-hard-to-fill booking is NOT auto-cancelled — it goes to ops.
    if (booking.autoRefundIfUnassigned === true) {
      // Only refund money that was actually captured. Unpaid bookings (pay-on-completion
      // or a failed capture) must NOT create a phantom PENDING refund that back-office
      // would otherwise pay out. Mirrors the PAID guard in cancelBookingByUser.
      const isPaid = booking.payment?.status === "PAID";
      const refundAmount = isPaid ? Number(booking.totalAmount || 0) : 0;
      const refundStatus = refundAmount > 0 ? "PENDING" : "NONE";
      const cancelReason = "No replacement partner available after partner cancellation";

      // Guarded transition: only cancel if the booking is STILL stuck with no partner.
      // If one was assigned concurrently (a queued retry succeeded, or ops assigned
      // manually), this returns null and we leave the live booking untouched.
      // runValidators surfaces any future enum/schema drift instead of writing silently.
      const cancelled = await Booking.findOneAndUpdate(
        { _id: bookingId, status: "NO_PARTNER_AVAILABLE" },
        {
          $set: {
            status: "CANCELLED",
            // "system" is the valid enum value for platform-initiated cancels
            // (Booking.cancelledBy enum = user | partner | system | admin).
            cancelledBy: "system",
            cancelledAt: new Date(),
            cancelReason,
            refundAmount,
            refundStatus,
          },
        },
        { new: true, runValidators: true }
      );

      if (!cancelled) {
        console.warn(
          `[escalation] Booking ${bookingId} no longer NO_PARTNER_AVAILABLE — a partner was assigned concurrently. Skipping auto-cancel.`
        );
        return { escalated: false, reason: "recovered" };
      }

      // Give the slot's capacity back — a cancelled booking must not keep
      // blocking other customers from booking this window. Lazy require to
      // avoid a circular import (slotCapacity → assignmentEngine → here).
      try {
        const { releaseSlotCapacityByBookingId } = require("./slotCapacity.service");
        await releaseSlotCapacityByBookingId(bookingId, {
          releaseReason: "auto_cancel_no_replacement",
        });
      } catch (releaseErr) {
        console.error(
          `[escalation] Slot capacity release failed for booking ${bookingId}: ${releaseErr.message}`
        );
      }

      if (global.io) {
        global.io.to(`user_${booking.user}`).emit("booking_update", {
          bookingId: String(bookingId),
          status: "CANCELLED",
          cancelledBy: "system",
          cancelReason,
          refundAmount,
          message: refundAmount > 0
            ? "We couldn't find a replacement professional. Your booking has been cancelled and a full refund will be processed."
            : "We couldn't find a replacement professional. Your booking has been cancelled.",
        });
      }

      console.warn(
        `[escalation] Booking ${bookingId} auto-cancelled — no replacement after partner cancellation. ` +
        (refundAmount > 0 ? `Refund ₹${refundAmount} queued.` : "Unpaid booking — no refund.")
      );

      if (global.io) {
        global.io.to("admin_ops").emit("booking_escalation", {
          bookingId: String(bookingId),
          userId: booking.user ? String(booking.user) : null,
          pincode: booking.pincode || "",
          amount: refundAmount,
          status: "CANCELLED",
          reason: "no_replacement_partner",
          scheduledDate: booking.scheduledDate,
          scheduledTime: booking.scheduledTime,
          timestamp: new Date().toISOString(),
        });
      }

      return { escalated: true, autoCancelled: true, refundAmount };
    }

    // Original assignment failure (no partner cancellation) — leave for ops to resolve manually.
    console.warn(
      `[escalation] Booking ${bookingId} needs ops attention — status=${booking.status}, pincode=${booking.pincode}, amount=${booking.totalAmount}, scheduled=${booking.scheduledDate} ${booking.scheduledTime}`
    );

    if (global.io) {
      global.io.to("admin_ops").emit("booking_escalation", {
        bookingId: String(bookingId),
        userId: booking.user ? String(booking.user) : null,
        pincode: booking.pincode || "",
        amount: Number(booking.totalAmount || 0),
        status: booking.status,
        scheduledDate: booking.scheduledDate,
        scheduledTime: booking.scheduledTime,
        timestamp: new Date().toISOString(),
      });
    }

    return { escalated: true };
  } catch (err) {
    console.error("[escalation] escalateUnassignedBooking failed:", err.message);
    return { escalated: false, reason: "error", error: err.message };
  }
}

module.exports = { escalateUnassignedBooking };
