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

// Reminder cron timing.
const REMINDER_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const REMINDER_LEAD_MINUTES = 30; // pre-job reminder fires ~30 min before service
const HELPER_NUDGE_AFTER_HOURS = 6; // nudge a still-pending helper invite after 6h

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
SEND PRE-JOB REMINDERS
Pushes a reminder to the assigned partner team, any
helpers on the booking, and the customer ~30 minutes
before an accepted job's scheduled start.
=====================================================
*/
async function sendJobReminders() {
  try {
    const Booking = require("../models/Booking");
    const Partner = require("../models/Partner");
    const User = require("../models/User");
    const { buildDateTime } = require("./scheduling_service");
    const { sendPushNotification } = require("./pushNotification.service");

    const now = new Date();
    const windowEnd = new Date(now.getTime() + REMINDER_LEAD_MINUTES * 60 * 1000);

    const candidates = await Booking.find({
      status: { $in: ["CONFIRMED", "PARTNER_ACCEPTED"] },
      preJobReminderSentAt: null,
    })
      .select(
        "_id scheduledDate scheduledTime scheduledStartAt partner additionalPartners helpers user"
      )
      .lean();

    let sentCount = 0;

    for (const booking of candidates) {
      const start = booking.scheduledStartAt
        ? new Date(booking.scheduledStartAt)
        : buildDateTime(booking.scheduledDate, booking.scheduledTime);

      if (!(start instanceof Date) || Number.isNaN(start.getTime())) continue;
      // Only remind for jobs starting within the lead window.
      if (!(start > now && start <= windowEnd)) continue;

      // Atomically claim the booking so the reminder is sent exactly once,
      // even if multiple server instances run this cron.
      const claimed = await Booking.findOneAndUpdate(
        { _id: booking._id, preJobReminderSentAt: null },
        { $set: { preJobReminderSentAt: now } }
      );
      if (!claimed) continue;

      const timeLabel = booking.scheduledTime || start.toLocaleTimeString();

      const partnerIds = [booking.partner, ...(booking.additionalPartners || [])]
        .filter(Boolean)
        .map((id) => String(id));
      const helperIds = (booking.helpers || [])
        .map((h) => h?.partnerId)
        .filter(Boolean)
        .map((id) => String(id));

      const teamPartners = await Partner.find({
        _id: { $in: [...partnerIds, ...helperIds] },
      })
        .select("_id fcmToken")
        .lean();
      const tokenById = new Map(
        teamPartners.map((p) => [String(p._id), p.fcmToken])
      );

      for (const partnerId of partnerIds) {
        const token = tokenById.get(partnerId);
        if (token) {
          sendPushNotification(
            token,
            "Upcoming Job",
            `Your job is scheduled at ${timeLabel}. Get ready to head out.`,
            { type: "JOB_REMINDER", bookingId: String(booking._id) }
          );
        }
      }

      for (const helperId of helperIds) {
        const token = tokenById.get(helperId);
        if (token) {
          sendPushNotification(
            token,
            "Upcoming Job",
            `You're helping on a job at ${timeLabel}. Get ready.`,
            { type: "JOB_REMINDER", bookingId: String(booking._id) }
          );
        }
      }

      if (booking.user) {
        const customer = await User.findById(booking.user)
          .select("fcmToken")
          .lean();
        if (customer?.fcmToken) {
          sendPushNotification(
            customer.fcmToken,
            "Service Reminder",
            `Your service is scheduled at ${timeLabel}. Your partner will arrive soon.`,
            { type: "BOOKING_REMINDER", bookingId: String(booking._id) }
          );
        }
      }

      sentCount += 1;
    }

    if (sentCount > 0) {
      console.log(`[cron] Sent pre-job reminders for ${sentCount} booking(s)`);
    }
  } catch (err) {
    console.error("[cron] sendJobReminders error:", err.message);
  }
}

/*
=====================================================
SEND HELPER INVITATION REMINDERS
Nudges a helper about a technician invitation that has
sat unanswered (PENDING) for HELPER_NUDGE_AFTER_HOURS.
=====================================================
*/
async function sendHelperInviteReminders() {
  try {
    const TechnicianHelper = require("../models/TechnicianHelper");
    const { sendPushNotification } = require("./pushNotification.service");

    const now = new Date();
    const cutoff = new Date(
      now.getTime() - HELPER_NUDGE_AFTER_HOURS * 60 * 60 * 1000
    );

    const pending = await TechnicianHelper.find({
      status: "PENDING",
      reminderSentAt: null,
      invitedAt: { $lt: cutoff },
    })
      .populate("technician", "name")
      .populate("helper", "fcmToken")
      .lean();

    let sentCount = 0;

    for (const invite of pending) {
      const claimed = await TechnicianHelper.findOneAndUpdate(
        { _id: invite._id, status: "PENDING", reminderSentAt: null },
        { $set: { reminderSentAt: now } }
      );
      if (!claimed) continue;

      const token = invite.helper?.fcmToken;
      if (token) {
        sendPushNotification(
          token,
          "Pending Helper Invitation",
          `${invite.technician?.name || "A technician"} invited you to join their team. Tap to accept or decline.`,
          { type: "HELPER_INVITE_REMINDER", invitationId: String(invite._id) }
        );
      }

      sentCount += 1;
    }

    if (sentCount > 0) {
      console.log(`[cron] Sent ${sentCount} helper invitation reminder(s)`);
    }
  } catch (err) {
    console.error("[cron] sendHelperInviteReminders error:", err.message);
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
  sendJobReminders();
  sendHelperInviteReminders();

  setInterval(cancelStaleBookings, CHECK_INTERVAL_MS);
  setInterval(dispatchQueuedBookings, CHECK_INTERVAL_MS);
  setInterval(cleanupExpiredSlotLocks, SLOT_LOCK_CHECK_INTERVAL_MS);
  setInterval(sendJobReminders, REMINDER_INTERVAL_MS);
  setInterval(sendHelperInviteReminders, REMINDER_INTERVAL_MS);

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
    console.log(
      `[cron] Job reminders active (checks every 5 min, reminds ${REMINDER_LEAD_MINUTES} min before service)`
    );
  }
}

module.exports = {
  initCronJobs,
  dispatchQueuedBookings,
  cleanupExpiredSlotLocks,
  sendJobReminders,
  sendHelperInviteReminders,
};
