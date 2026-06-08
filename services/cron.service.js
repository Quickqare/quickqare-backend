/*
=====================================================
CRON SERVICE
Runs periodic background jobs using setInterval.
No external scheduler library required.
=====================================================
*/

const STALE_HOURS = 48;
const PARTNER_HISTORY_DAYS = 60;
const HISTORY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes

// No-show thresholds: how many hours past scheduled time before we flag a booking
const NO_SHOW_ACCEPTED_HOURS  = 2; // PARTNER_ACCEPTED but didn't show up
const NO_SHOW_ON_THE_WAY_HOURS = 3; // ON_THE_WAY but never arrived
const NO_SHOW_ARRIVED_HOURS   = 4; // ARRIVED but never started

// Professional reasons shown to customer (auto-selected by cron)
const RESCHEDULE_REASON = {
  NO_SHOW:      "Due to an unforeseen emergency with your assigned professional",
  ON_THE_WAY:   "Due to an unforeseen circumstance during transit",
  ARRIVED:      "Due to an operational issue on our end",
};
const PAYOUT_RETRY_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
// Only retry payouts that have been pending for at least this long (process crash window)
const PAYOUT_RETRY_AFTER_MS = 5 * 60 * 1000; // 5 minutes
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
      //
      // Await sequentially: dispatching one booking at a time serialises partner
      // selection so a batch of same-slot bookings doesn't stampede the same
      // partner. The atomic claim inside assignBooking is the hard guarantee;
      // this just avoids needless write contention from firing them in parallel.
      try {
        await assignBooking(b._id, { requireOnline: false });
      } catch (err) {
        console.error(`[cron] assignBooking failed for ${b._id}:`, err.message);
      }
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
RETRY ORPHANED PAYOUTS
Catches COMPLETED bookings whose wallet credits never
ran (e.g. process crash between status flip and credit).
creditWallet is idempotent via unique WalletTransaction
index, so retrying an already-credited booking is safe.
=====================================================
*/
async function retryPendingPayouts() {
  try {
    const Booking = require("../models/Booking");
    const { creditWallet } = require("../controllers/partnerWallet.controller");
    const { syncPartnerOperationalState } = require("./scheduling_service");
    const { processReferralReward } = require("../utils/referral");

    const roundAmount = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

    const cutoff = new Date(Date.now() - PAYOUT_RETRY_AFTER_MS);

    const orphaned = await Booking.find({
      status: "COMPLETED",
      payoutStatus: "pending",
      completedAt: { $lt: cutoff },
    })
      .select("_id partner additionalPartners partnerSettlement user")
      .lean();

    if (!orphaned.length) return;

    console.log(`[cron] Retrying payouts for ${orphaned.length} orphaned booking(s)`);

    for (const booking of orphaned) {
      try {
        const settlement = booking.partnerSettlement;

        if (!settlement?.partnerEarningAmount || !booking.partner) {
          console.error(`[cron] Booking ${booking._id} missing settlement or partner — marking failed`);
          await Booking.findByIdAndUpdate(booking._id, { $set: { payoutStatus: "failed" } });
          continue;
        }

        const additionalPartners = booking.additionalPartners || [];
        const totalCount = 1 + additionalPartners.length;
        const splitAmount = roundAmount(settlement.partnerEarningAmount / totalCount);

        for (const additionalPartnerId of additionalPartners) {
          await creditWallet({
            partnerId: additionalPartnerId,
            amount: splitAmount,
            reason: "job_payment",
            bookingId: booking._id,
            description: `Earning from booking #${booking._id} (Pending 48h Settlement)`,
            bucket: "pending",
          });
          await syncPartnerOperationalState(additionalPartnerId);
        }

        const mainShare =
          additionalPartners.length > 0
            ? roundAmount(settlement.partnerEarningAmount - splitAmount * additionalPartners.length)
            : settlement.partnerEarningAmount;

        await creditWallet({
          partnerId: booking.partner,
          amount: mainShare,
          reason: "job_payment",
          bookingId: booking._id,
          description: `Earning from booking #${booking._id} (Pending 48h Settlement)`,
          bucket: "pending",
        });
        await syncPartnerOperationalState(booking.partner);

        await processReferralReward(booking.user, booking._id);

        await Booking.findByIdAndUpdate(booking._id, { $set: { payoutStatus: "credited" } });

        console.log(`[cron] Payout retry succeeded for booking ${booking._id}`);
      } catch (err) {
        console.error(`[cron] Payout retry failed for booking ${booking._id}:`, err.message);
        await Booking.findByIdAndUpdate(booking._id, { $set: { payoutStatus: "failed" } });
      }
    }
  } catch (err) {
    console.error("[cron] retryPendingPayouts error:", err.message);
  }
}

/*
=====================================================
DETECT NO-SHOW PARTNERS
Flags bookings where the partner accepted but failed
to attend. Moves them to NEEDS_RESCHEDULING and
gives the partner a cancellation strike.

Triggers (hours past scheduledStartAt):
  PARTNER_ACCEPTED → 2h
  ON_THE_WAY       → 3h
  ARRIVED          → 4h
=====================================================
*/
async function detectNoShowPartners() {
  try {
    const Booking = require("../models/Booking");
    const Partner = require("../models/Partner");
    const { notifyCustomerOfBookingStatus } = require("./pushNotification.service");
    const now = new Date();

    const checks = [
      {
        status: "PARTNER_ACCEPTED",
        cutoffHours: NO_SHOW_ACCEPTED_HOURS,
        reason: RESCHEDULE_REASON.NO_SHOW,
      },
      {
        status: "ON_THE_WAY",
        cutoffHours: NO_SHOW_ON_THE_WAY_HOURS,
        reason: RESCHEDULE_REASON.ON_THE_WAY,
      },
      {
        status: "ARRIVED",
        cutoffHours: NO_SHOW_ARRIVED_HOURS,
        reason: RESCHEDULE_REASON.ARRIVED,
      },
    ];

    for (const { status, cutoffHours, reason } of checks) {
      const cutoff = new Date(now.getTime() - cutoffHours * 60 * 60 * 1000);

      const bookings = await Booking.find({
        status,
        scheduledStartAt: { $lt: cutoff },
        rescheduleRequestedAt: null, // not already flagged
        partner: { $ne: null },
      }).select("_id user partner weeklyCancelCount");

      for (const booking of bookings) {
        // Atomically move to NEEDS_RESCHEDULING
        const updated = await Booking.findOneAndUpdate(
          { _id: booking._id, status, rescheduleRequestedAt: null },
          {
            $set: {
              status: "NEEDS_RESCHEDULING",
              rescheduleReason: reason,
              rescheduleRequestedAt: now,
            },
          },
          { new: true }
        );
        if (!updated) continue; // race condition — already handled

        // Partner cancellation strike
        if (booking.partner) {
          const partner = await Partner.findById(booking.partner);
          if (partner) {
            partner.weeklyCancelCount = (partner.weeklyCancelCount || 0) + 1;
            if (partner.weeklyCancelCount >= 5) {
              partner.isBlocked = true;
              console.warn(`[no-show] Auto-suspended partner ${partner._id} after no-show strike`);
            }
            await partner.save();
          }
        }

        // Notify customer via push
        notifyCustomerOfBookingStatus(booking.user, "NEEDS_RESCHEDULING", booking._id);

        // Notify customer via socket
        if (global.io) {
          global.io.to(`user_${booking.user}`).emit("booking_update", {
            bookingId: booking._id.toString(),
            status: "NEEDS_RESCHEDULING",
            rescheduleReason: reason,
          });
        }

        console.log(`[no-show] Booking ${booking._id} (was ${status}) → NEEDS_RESCHEDULING. Partner ${booking.partner} struck.`);
      }
    }
  } catch (err) {
    console.error("[cron] detectNoShowPartners error:", err.message);
  }
}

/*
=====================================================
PURGE OLD PARTNER JOB HISTORY
Removes partner references from bookings older than
60 days that have no open/in-review dispute.
This prevents partners from ever seeing those jobs
again (the query filter is the first gate; this
scrub is the permanent one).
Runs once daily.
=====================================================
*/
async function purgeOldPartnerJobHistory() {
  try {
    const Booking = require("../models/Booking");
    const Dispute = require("../admin/models/Dispute");

    const cutoff = new Date(Date.now() - PARTNER_HISTORY_DAYS * 24 * 60 * 60 * 1000);

    // Booking IDs that still have an open dispute — must NOT be scrubbed
    const disputedIds = await Dispute.distinct("bookingId", {
      status: { $in: ["OPEN", "IN_REVIEW"] },
    });

    const result = await Booking.updateMany(
      {
        createdAt: { $lt: cutoff },
        _id: { $nin: disputedIds },
        $or: [
          { partner: { $ne: null } },
          { "additionalPartners.0": { $exists: true } },
          { "partnerCancellations.0": { $exists: true } },
        ],
      },
      {
        $set: { partner: null, additionalPartners: [], partnerCancellations: [] },
      }
    );

    if (result.modifiedCount > 0) {
      console.log(
        `[cron] Purged partner references from ${result.modifiedCount} booking(s) older than ${PARTNER_HISTORY_DAYS} days`
      );
    }
  } catch (err) {
    console.error("[cron] purgeOldPartnerJobHistory error:", err.message);
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
  retryPendingPayouts();
  detectNoShowPartners();
  purgeOldPartnerJobHistory();

  setInterval(cancelStaleBookings, CHECK_INTERVAL_MS);
  setInterval(dispatchQueuedBookings, CHECK_INTERVAL_MS);
  setInterval(cleanupExpiredSlotLocks, SLOT_LOCK_CHECK_INTERVAL_MS);
  setInterval(sendJobReminders, REMINDER_INTERVAL_MS);
  setInterval(sendHelperInviteReminders, REMINDER_INTERVAL_MS);
  setInterval(retryPendingPayouts, PAYOUT_RETRY_INTERVAL_MS);
  setInterval(detectNoShowPartners, CHECK_INTERVAL_MS);
  setInterval(purgeOldPartnerJobHistory, HISTORY_CLEANUP_INTERVAL_MS);

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
  retryPendingPayouts,
  detectNoShowPartners,
  purgeOldPartnerJobHistory,
};
