/*
=====================================================
CRON SERVICE
Runs periodic background jobs using setInterval.
No external scheduler library required.
=====================================================
*/

const STALE_HOURS = 48;
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes
const SLOT_LOCK_CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// QUEUED bookings are dispatched when they are this many hours before service.
// 3 hours gives the partner enough notice while not assigning too far in advance.
const DISPATCH_HOURS_BEFORE = 3;

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
    const { releaseSlotCapacityByBookingId } = require("./slotCapacity.service");
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

    for (const id of ids) {
      await releaseSlotCapacityByBookingId(id, {
        releaseReason: "stale_booking_cleanup",
      });
    }

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
DISPATCH QUEUED BOOKINGS
Fires assignBooking for any QUEUED booking whose
scheduled time is now within DISPATCH_HOURS_BEFORE
hours. Uses requireOnline:false so partners don't
need to be online at the moment of pre-assignment —
they just need to be approved and available.
=====================================================
*/
async function dispatchQueuedBookings() {
  try {
    const Booking = require("../models/Booking");
    const { assignBooking } = require("./assignmentEngine");
    const { buildDateTime } = require("./scheduling_service");

    const now = new Date();
    const dispatchWindow = new Date(now.getTime() + DISPATCH_HOURS_BEFORE * 60 * 60 * 1000);

    // Find QUEUED bookings whose scheduled start is within the dispatch window.
    // We use scheduledStartAt when available, falling back to scheduledDate+scheduledTime.
    const queued = await Booking.find({ status: "QUEUED" })
      .select("_id scheduledDate scheduledTime scheduledStartAt user pincode")
      .lean();

    const toDispatch = queued.filter((b) => {
      const start = b.scheduledStartAt
        ? new Date(b.scheduledStartAt)
        : buildDateTime(b.scheduledDate, b.scheduledTime);
      return start <= dispatchWindow && start > now;
    });

    if (!toDispatch.length) return;

    console.log(`[cron] Dispatching ${toDispatch.length} queued booking(s)`);

    for (const b of toDispatch) {
      // Move to SEARCHING so the customer sees status update
      await Booking.updateOne({ _id: b._id, status: "QUEUED" }, {
        $set: { status: "SEARCHING" },
      });

      if (global.io) {
        global.io.to(`user_${b.user}`).emit("booking_update", {
          bookingId: b._id.toString(),
          status: "SEARCHING",
        });
      }

      // requireOnline:false — partner may not be online 3 h before service but
      // will be by the time the job starts. Assignment locks them in now.
      assignBooking(b._id, { requireOnline: false }).catch((err) => {
        console.error(`[cron] assignBooking failed for ${b._id}:`, err.message);
      });
    }
  } catch (err) {
    console.error("[cron] dispatchQueuedBookings error:", err.message);
  }
}

async function cleanupExpiredSlotLocks() {
  try {
    const { cleanupExpiredSlotLocks } = require("./slotCapacity.service");
    const result = await cleanupExpiredSlotLocks();
    if (result?.released) {
      console.log(`[cron] Released ${result.released} expired slot lock(s)`);
    }
  } catch (err) {
    console.error("[cron] cleanupExpiredSlotLocks error:", err.message);
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
  dispatchQueuedBookings();
  cleanupExpiredSlotLocks();

  setInterval(cancelStaleBookings, CHECK_INTERVAL_MS);
  setInterval(dispatchQueuedBookings, CHECK_INTERVAL_MS);
  setInterval(cleanupExpiredSlotLocks, SLOT_LOCK_CHECK_INTERVAL_MS);

  if (process.env.NODE_ENV !== "test") {
    console.log(
      `[cron] Stale booking auto-cancel active (checks every 30 min, threshold ${STALE_HOURS}h)`
    );
    console.log(
      `[cron] Queued booking dispatch active (fires ${DISPATCH_HOURS_BEFORE}h before service, checks every 30 min)`
    );
    console.log(
      `[cron] Slot lock cleanup active (checks every 5 min, expires ${require("./slotCapacity.service").SLOT_LOCK_MINUTES} min locks)`
    );
  }
}

module.exports = { initCronJobs, dispatchQueuedBookings, cleanupExpiredSlotLocks };
