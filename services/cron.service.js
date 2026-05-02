/*
=====================================================
CRON SERVICE
Runs periodic background jobs using setInterval.
No external scheduler library required.
=====================================================
*/

const STALE_HOURS = 48;
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes

// Statuses that indicate a booking is stuck and should be auto-cancelled
const STALE_PENDING_STATUSES = [
  "PENDING_ASSIGNMENT",
  "QUEUED",
  "SEARCHING",
  "NO_PARTNER_AVAILABLE",
];

/*
=====================================================
AUTO-CANCEL STALE BOOKINGS
Rules:
  PENDING_PAYMENT — lock expired AND booking is
    older than STALE_HOURS (payment never completed).
  PENDING_ASSIGNMENT / QUEUED / SEARCHING /
    NO_PARTNER_AVAILABLE — booking has not moved
    for STALE_HOURS (no partner could be found).
=====================================================
*/
async function cancelStaleBookings() {
  try {
    const Booking = require("../models/Booking");
    const cutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000);
    const now = new Date();

    const stale = await Booking.find({
      $or: [
        // Payment window expired and booking sat idle for 48 h
        {
          status: "PENDING_PAYMENT",
          lockedUntil: { $lt: now },
          createdAt: { $lt: cutoff },
        },
        // Assignment-stuck bookings not updated in 48 h
        {
          status: { $in: STALE_PENDING_STATUSES },
          updatedAt: { $lt: cutoff },
        },
      ],
    }).select("_id status");

    if (!stale.length) return;

    const ids = stale.map((b) => b._id);
    const result = await Booking.updateMany(
      { _id: { $in: ids } },
      { $set: { status: "CANCELLED", cancelledBy: "system" } }
    );

    console.log(
      `[cron] Auto-cancelled ${result.modifiedCount} stale bookings (>${STALE_HOURS}h)`
    );
  } catch (err) {
    console.error("[cron] cancelStaleBookings error:", err.message);
  }
}

/*
=====================================================
INIT — called once after MongoDB connects
=====================================================
*/
function initCronJobs() {
  // Run once on startup to catch stale bookings from before last restart
  cancelStaleBookings();

  setInterval(cancelStaleBookings, CHECK_INTERVAL_MS);

  if (process.env.NODE_ENV !== "test") {
    console.log(
      `[cron] Stale booking auto-cancel active (checks every 30 min, threshold ${STALE_HOURS}h)`
    );
  }
}

module.exports = { initCronJobs };
