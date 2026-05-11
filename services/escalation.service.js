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
      .select("user pincode totalAmount status scheduledDate scheduledTime")
      .lean();

    if (!booking) {
      console.warn(`[escalation] Booking ${bookingId} not found — nothing to escalate`);
      return { escalated: false, reason: "not_found" };
    }

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
