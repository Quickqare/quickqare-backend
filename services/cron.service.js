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

// ── Learning loop (the "small brain") ──────────────────────────────────────
// Nightly jobs that turn recorded outcomes into learned parameters the same
// synchronous assignment engine already consumes. All strictly bounded and
// clamped — never non-deterministic, never in the assignment hot path.
const LEARNING_INTERVAL_MS = 24 * 60 * 60 * 1000; // durations + travel, once per day
const LEARNING_LOOKBACK_DAYS = 30; // completed-booking window the learners aggregate over
const LEARNED_DURATION_MIN_BATCH = 5; // need this many clean samples before writing a service
const LEARNED_TRAVEL_MIN_BATCH = 10; // need this many samples before writing a category
const LEARNED_EWMA_ALPHA = 0.3; // weight of the new batch vs the prior learned value
const SHADOW_INTERVAL_MS = 24 * 60 * 60 * 1000; // weight-shadow report, once per day
const SHADOW_LOOKBACK_DAYS = 7;
const SHADOW_MAX_BOOKINGS = 5000; // hard cap on bookings scanned per shadow run
// Candidate weighting the shadow report tests against the live one: shift 0.10
// from idle onto reliability. Applied to whichever live set (AC/general) the
// booking used, so the sum stays 1.0.
const SHADOW_RELIABILITY_SHIFT = 0.1;

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
// A transient error (network blip, brief DB hiccup) must not permanently
// strand a partner's earnings: retry up to this many times before marking the
// payout "failed" for manual admin intervention. creditWallet is idempotent,
// so re-running a partially-credited booking is safe.
const PAYOUT_MAX_RETRIES = 5;
const SLOT_LOCK_CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// QUEUED bookings are dispatched when they are this many hours before service.
// 3 hours gives the partner enough notice while not assigning too far in advance.
const DISPATCH_HOURS_BEFORE = 3;

// Reminder cron timing.
const REMINDER_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const REMINDER_LEAD_MINUTES = 30; // pre-job reminder fires ~30 min before service
const HELPER_NUDGE_AFTER_HOURS = 6; // nudge a still-pending helper invite after 6h

// Cake order reminder — reminds the assigned baker ~24h before delivery so a
// multi-day-ahead order doesn't get forgotten. Checked hourly; the window is
// wide enough (24-25h) that an hourly cadence can't skip a booking entirely.
const CAKE_REMINDER_INTERVAL_MS = 60 * 60 * 1000; // every hour
const CAKE_REMINDER_LEAD_HOURS = 24;

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
    }).select("_id status payment totalAmount");

    if (!stale.length) return;

    const ids = stale.map((b) => b._id);

    for (const id of ids) {
      await releaseSlotCapacityByBookingId(id, {
        releaseReason: "stale_booking_cleanup",
      });
    }

    // Statuses we'll cancel from — guard the writes so a concurrently-transitioned
    // booking (e.g. a partner just got assigned) isn't clobbered.
    const fromStatuses = ["PENDING_PAYMENT", ...STALE_PENDING_STATUSES];

    // A PAID booking the platform failed to fulfil gets a full refund (PENDING); unpaid /
    // payment-expired ones are simply cancelled with no refund. Previously ALL stale
    // bookings were cancelled with no refund — a paid customer could lose their money.
    const paidIds = stale.filter((b) => b.payment?.status === "PAID").map((b) => b._id);
    const unpaidIds = stale.filter((b) => b.payment?.status !== "PAID").map((b) => b._id);

    let modified = 0;
    if (paidIds.length) {
      const r = await Booking.updateMany(
        { _id: { $in: paidIds }, status: { $in: fromStatuses } },
        [
          {
            $set: {
              status: "CANCELLED",
              cancelledBy: "system",
              cancelReason: "Auto-cancelled: no professional available (stale booking)",
              cancelledAt: now,
              refundAmount: { $ifNull: ["$totalAmount", 0] },
              refundStatus: {
                $cond: [{ $gt: [{ $ifNull: ["$totalAmount", 0] }, 0] }, "PENDING", "NONE"],
              },
            },
          },
        ]
      );
      modified += r.modifiedCount || 0;
    }
    if (unpaidIds.length) {
      const r = await Booking.updateMany(
        { _id: { $in: unpaidIds }, status: { $in: fromStatuses } },
        {
          $set: {
            status: "CANCELLED",
            cancelledBy: "system",
            cancelReason: "Auto-cancelled: stale booking",
            cancelledAt: now,
          },
        }
      );
      modified += r.modifiedCount || 0;
    }

    console.log(
      `[cron] Auto-cancelled ${modified} stale bookings (>${STALE_HOURS}h); ${paidIds.length} paid → full refund queued`
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
      .select("_id scheduledDate scheduledTime scheduledStartAt user pincode services.options.flavour")
      .lean();

    const toDispatch = queued.filter((b) => {
      const start = b.scheduledStartAt
        ? new Date(b.scheduledStartAt)
        : buildDateTime(b.scheduledDate, b.scheduledTime);
      // Past-start QUEUED bookings are dispatched too — assignBooking either
      // still staffs them (within its 60-min grace) or escalates + releases
      // capacity immediately. Filtering them out stranded a PAID booking in
      // QUEUED for 48h until the stale cron cancelled it, with no timely
      // customer notification or refund.
      if (start <= now) return true;
      // Customized (cake) orders never wait for the T-3h window — the baker
      // needs the full lead time to bake. Normally they're assigned at payment
      // (paymentFinalize skips QUEUED for them), so any QUEUED one here is a
      // straggler (admin requeue, queueOnFailure retry, legacy row): dispatch
      // it on this pass regardless of how far ahead it's scheduled.
      const isCake = (b.services || []).some((s) => s?.options?.flavour);
      return isCake || start <= dispatchWindow;
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
SEND CAKE ORDER REMINDERS (DAY-BEFORE)
Cake orders are booked at least a day ahead, so it's
easy for a baker to forget one. Pushes a reminder to
the assigned baker once the delivery is within
CAKE_REMINDER_LEAD_HOURS, mirroring sendJobReminders'
"catch it whenever it enters the lead window" approach
but with a much wider (24h) window checked hourly —
still ~24x oversampling, same safety margin.
=====================================================
*/
async function sendCakeOrderReminders() {
  try {
    const Booking = require("../models/Booking");
    const Partner = require("../models/Partner");
    const { buildDateTime } = require("./scheduling_service");
    const { sendPushNotification } = require("./pushNotification.service");

    const now = new Date();
    const windowEnd = new Date(now.getTime() + CAKE_REMINDER_LEAD_HOURS * 60 * 60 * 1000);

    const candidates = await Booking.find({
      status: { $in: ["ASSIGNED", "CONFIRMED", "PARTNER_ACCEPTED"] },
      cakeReminderSentAt: null,
      partner: { $ne: null },
      "services.options.flavour": { $exists: true, $ne: null },
    })
      .select("_id scheduledDate scheduledTime scheduledStartAt partner services")
      .lean();

    let sentCount = 0;

    for (const booking of candidates) {
      const start = booking.scheduledStartAt
        ? new Date(booking.scheduledStartAt)
        : buildDateTime(booking.scheduledDate, booking.scheduledTime);

      if (!(start instanceof Date) || Number.isNaN(start.getTime())) continue;
      if (!(start > now && start <= windowEnd)) continue;

      // Atomic claim so the reminder is sent exactly once even with multiple
      // server instances running this cron.
      const claimed = await Booking.findOneAndUpdate(
        { _id: booking._id, cakeReminderSentAt: null },
        { $set: { cakeReminderSentAt: now } }
      );
      if (!claimed) continue;

      const cakeLine = (booking.services || []).find((s) => s?.options?.flavour);
      const flavour = cakeLine?.options?.flavour || "";
      const nameOnCake = cakeLine?.options?.nameOnCake || "";
      const dateLabel = new Date(booking.scheduledDate).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
      });

      const body = nameOnCake
        ? `Cake order due ${dateLabel}: ${flavour}, "${nameOnCake}". Get baking!`
        : `Cake order due ${dateLabel}: ${flavour}. Get baking!`;

      const partner = await Partner.findById(booking.partner).select("fcmToken").lean();
      if (partner?.fcmToken) {
        sendPushNotification(
          partner.fcmToken,
          "Cake order due tomorrow",
          body,
          { type: "CAKE_ORDER_REMINDER", bookingId: String(booking._id) }
        );
        sentCount += 1;
      }
    }

    if (sentCount > 0) {
      console.log(`[cron] Sent cake order reminders for ${sentCount} booking(s)`);
    }
  } catch (err) {
    console.error("[cron] sendCakeOrderReminders error:", err.message);
  }
}

/*
=====================================================
ENFORCE ADVANCE-ASSIGNMENT ACK DEADLINES
Advance assignments (start >3h away — cake orders
assigned at payment, evening payments for a morning
slot) don't run the 2-minute socket ACK timer: the
partner may legitimately be offline when the job
lands. This cron enforces the wider deadline instead —
reassign if still unacknowledged 12h after assignment,
or once the start is within the T-3h dispatch window.
Restart-safe by construction: state lives entirely in
the booking row (assignedAt / ackReceivedAt), no
timers. handleAckTimeout re-checks everything
atomically-enough (ackReceivedAt, status, window) so a
double fire is a no-op.
=====================================================
*/
async function enforceAdvanceAckDeadlines() {
  try {
    const Booking = require("../models/Booking");
    const {
      handleAckTimeout,
      ADVANCE_IMMINENT_MS,
      ADVANCE_ACK_WINDOW_MS,
    } = require("./ackTimeout.service");

    const now = Date.now();
    const assignedCutoff = new Date(now - ADVANCE_ACK_WINDOW_MS);
    const imminentCutoff = new Date(now + ADVANCE_IMMINENT_MS);

    const expired = await Booking.find({
      status: "ASSIGNED",
      ackReceivedAt: null,
      partner: { $ne: null },
      assignedAt: { $ne: null },
      // ADVANCE-originated only (start was >3h away at assignment time) — an
      // imminent assignment's 2-minute timer owns it exclusively; matching it
      // here would reassign it before its 2 minutes are up.
      $expr: {
        $gt: [
          { $subtract: ["$scheduledStartAt", "$assignedAt"] },
          ADVANCE_IMMINENT_MS,
        ],
      },
      $or: [
        { assignedAt: { $lte: assignedCutoff } },
        { scheduledStartAt: { $lte: imminentCutoff } },
      ],
    })
      .select("_id partner")
      .lean();

    for (const booking of expired) {
      await handleAckTimeout(booking._id, booking.partner);
    }

    if (expired.length) {
      console.log(
        `[cron] Advance-ACK deadline expired for ${expired.length} booking(s) — reassignment triggered`
      );
    }
  } catch (err) {
    console.error("[cron] enforceAdvanceAckDeadlines error:", err.message);
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
      .select("_id partner additionalPartners partnerSettlement user payoutRetryCount")
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
        const attempts = Number(booking.payoutRetryCount || 0) + 1;
        console.error(
          `[cron] Payout retry ${attempts}/${PAYOUT_MAX_RETRIES} failed for booking ${booking._id}:`,
          err.message
        );

        if (attempts >= PAYOUT_MAX_RETRIES) {
          // Exhausted — needs a human. Alert ops so it doesn't rot silently.
          await Booking.findByIdAndUpdate(booking._id, {
            $set: { payoutStatus: "failed", payoutRetryCount: attempts },
          });
          if (global.io) {
            global.io.to("admin_ops").emit("payout_failed", {
              bookingId: String(booking._id),
              partnerId: booking.partner ? String(booking.partner) : null,
              attempts,
              error: err.message,
              timestamp: new Date().toISOString(),
            });
          }
        } else {
          // Transient failure — stay "pending" so the next cron pass retries.
          await Booking.findByIdAndUpdate(booking._id, {
            $set: { payoutRetryCount: attempts },
          });
        }
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

        // Partner no-show strike — shared atomic implementation (weekly reset
        // + auto-suspension), same as the cancel/reject paths. The old
        // read-modify-write here never reset the weekly counter.
        if (booking.partner) {
          try {
            const { recordPartnerStrike } = require("./partnerLifecycle.service");
            await recordPartnerStrike(booking.partner);
            // Lifetime no-show counter — feeds the reliability score's no-show
            // penalty (was a dead schema field until now). Kept out of
            // recordPartnerStrike because that path also handles plain
            // cancels/rejects, which are not no-shows.
            await Partner.updateOne(
              { _id: booking.partner },
              { $inc: { noShowCount: 1 } }
            );
          } catch (strikeErr) {
            console.error(`[no-show] Strike recording failed for partner ${booking.partner}: ${strikeErr.message}`);
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
Removes partner references from TERMINAL bookings (COMPLETED / CANCELLED)
older than 60 days that have no open/in-review dispute. This prevents
partners from ever seeing those jobs again (the query filter is the first
gate; this scrub is the permanent one).

The status filter matters: createdAt alone can't tell a delivered job from
one still in flight. A cake pre-order can be booked (createdAt) months before
its scheduled delivery date, and a NEEDS_RESCHEDULING/ASSIGNED booking can sit
for a while mid-dispute-free lifecycle — purging the partner reference off
either of those strands an active job with no assigned partner. Only a
booking that has actually finished (or been cancelled) is safe to scrub.
Runs once daily.
=====================================================
*/
const PARTNER_HISTORY_PURGEABLE_STATUSES = ["COMPLETED", "CANCELLED"];

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
        status: { $in: PARTNER_HISTORY_PURGEABLE_STATUSES },
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

// Mean after dropping the top/bottom 10% — kills single-outlier skew (one job
// where the partner forgot to tap "arrived" for two hours) without needing a
// full median. Returns null for an empty set.
function trimmedMean(values) {
  const arr = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return null;
  const cut = Math.floor(arr.length * 0.1);
  const kept = arr.length > 2 * cut + 1 ? arr.slice(cut, arr.length - cut) : arr;
  return kept.reduce((s, v) => s + v, 0) / kept.length;
}

// EWMA blend of a fresh batch mean into the prior learned value.
function ewmaBlend(prior, batch) {
  if (!Number.isFinite(prior) || prior <= 0) return batch;
  return LEARNED_EWMA_ALPHA * batch + (1 - LEARNED_EWMA_ALPHA) * prior;
}

/*
=====================================================
LEARN SERVICE DURATIONS  (fix 3)
Turns real on-site time (inProgressAt -> completedAt) of COMPLETED,
single-line, single-unit bookings into Service.learnedDurationMinutes via
EWMA, clamped to +/-40% of the admin-entered duration. Only single-line
single-unit jobs are used so the whole elapsed time maps cleanly to one
service (team/multi-cart jobs would mis-attribute). The reader
(serviceDurationMinutes) ignores the learned value until >= 5 samples, so a
thin batch can't take over. Runs once per day.
=====================================================
*/
async function learnServiceDurations() {
  try {
    const Booking = require("../models/Booking");
    const Service = require("../models/service.model");
    const {
      LEARNED_DURATION_MIN_FACTOR,
      LEARNED_DURATION_MAX_FACTOR,
    } = require("./scheduling_service");
    const cutoff = new Date(Date.now() - LEARNING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    // Collect actual minutes per serviceId from clean single-unit jobs.
    const bookings = await Booking.find({
      status: "COMPLETED",
      inProgressAt: { $ne: null },
      completedAt: { $ne: null, $gte: cutoff },
      services: { $size: 1 },
    })
      .select("services inProgressAt completedAt")
      .lean();

    const samplesByService = new Map(); // serviceIdString -> number[]
    for (const b of bookings) {
      const line = b.services?.[0];
      const serviceId = line?.serviceId;
      if (!serviceId) continue;
      const qty = Number(line?.quantity || 1);
      if (qty > 1) continue; // single unit only
      const mins = (new Date(b.completedAt) - new Date(b.inProgressAt)) / 60000;
      if (!(mins >= 5 && mins <= 600)) continue; // drop garbage timestamps
      const key = String(serviceId);
      if (!samplesByService.has(key)) samplesByService.set(key, []);
      samplesByService.get(key).push(mins);
    }

    let updated = 0;
    for (const [serviceId, samples] of samplesByService) {
      if (samples.length < LEARNED_DURATION_MIN_BATCH) continue;
      const service = await Service.findById(serviceId).select(
        "duration learnedDurationMinutes"
      );
      if (!service) continue;
      const catalog = Math.max(Number(service.duration) || 60, 1);
      const batchMean = trimmedMean(samples);
      if (!Number.isFinite(batchMean)) continue;
      const blended = ewmaBlend(Number(service.learnedDurationMinutes), batchMean);
      const clamped = Math.round(
        Math.min(
          Math.max(blended, catalog * LEARNED_DURATION_MIN_FACTOR),
          catalog * LEARNED_DURATION_MAX_FACTOR
        )
      );
      await Service.updateOne(
        { _id: serviceId },
        { $set: { learnedDurationMinutes: clamped, learnedDurationSamples: samples.length } }
      );
      updated += 1;
    }

    if (updated > 0) {
      console.log(`[learn] Service durations updated for ${updated} service(s) from ${bookings.length} completed jobs`);
    }
  } catch (err) {
    console.error("[cron] learnServiceDurations error:", err.message);
  }
}

/*
=====================================================
LEARN TRAVEL TIMES  (fix 4)
Turns real transit time (onTheWayAt -> arrivedAt) of COMPLETED bookings into
a learned flat travel buffer per category (general vs AC), stored in
LearnedStat "travelBuffer" via EWMA and clamped to the category band. This is
what the scheduler actually uses as the flat door-to-door buffer, so wrong
buffers (too fat -> false "slot full"; too thin -> back-to-back lateness) get
corrected toward reality. No per-km math: bookings don't snapshot the
partner's start point, so we learn the observed transit TIME directly, which
is exactly what the flat buffer represents. Runs once per day.
=====================================================
*/
async function learnTravelTimes() {
  try {
    const Booking = require("../models/Booking");
    const LearnedStat = require("../models/LearnedStat");
    const { isACBooking } = require("./assignmentEngine");
    const {
      TRAVEL_BUFFER_GENERAL_MIN,
      TRAVEL_BUFFER_GENERAL_MAX,
      TRAVEL_BUFFER_AC_MIN,
      TRAVEL_BUFFER_AC_MAX,
    } = require("./scheduling_service");
    const cutoff = new Date(Date.now() - LEARNING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const bookings = await Booking.find({
      status: "COMPLETED",
      onTheWayAt: { $ne: null },
      arrivedAt: { $ne: null },
      completedAt: { $gte: cutoff },
    })
      .select("serviceCategory services onTheWayAt arrivedAt")
      .lean();

    const buckets = { general: [], ac: [] };
    for (const b of bookings) {
      const mins = (new Date(b.arrivedAt) - new Date(b.onTheWayAt)) / 60000;
      if (!(mins >= 1 && mins <= 180)) continue; // drop garbage / same-timestamp
      (isACBooking(b) ? buckets.ac : buckets.general).push(mins);
    }

    const prior = await LearnedStat.findOne({ key: "travelBuffer" }).lean();
    const data = { ...(prior?.data || {}) };
    const sampleCounts = { ...(prior?.data?.samples || {}) };
    let changed = false;

    for (const [cat, band] of [
      ["general", [TRAVEL_BUFFER_GENERAL_MIN, TRAVEL_BUFFER_GENERAL_MAX]],
      ["ac", [TRAVEL_BUFFER_AC_MIN, TRAVEL_BUFFER_AC_MAX]],
    ]) {
      const samples = buckets[cat];
      if (samples.length < LEARNED_TRAVEL_MIN_BATCH) continue;
      const batchMean = trimmedMean(samples);
      if (!Number.isFinite(batchMean)) continue;
      const blended = ewmaBlend(Number(data[cat]), batchMean);
      data[cat] = Math.round(Math.min(Math.max(blended, band[0]), band[1]));
      sampleCounts[cat] = samples.length;
      changed = true;
    }

    if (changed) {
      data.samples = sampleCounts;
      const totalSamples = (sampleCounts.general || 0) + (sampleCounts.ac || 0);
      await LearnedStat.updateOne(
        { key: "travelBuffer" },
        { $set: { data, samples: totalSamples } },
        { upsert: true }
      );
      console.log(
        `[learn] Travel buffers updated: general=${data.general ?? "—"}m ac=${data.ac ?? "—"}m ` +
          `(samples g=${sampleCounts.general || 0} ac=${sampleCounts.ac || 0})`
      );
    }
  } catch (err) {
    console.error("[cron] learnTravelTimes error:", err.message);
  }
}

/*
=====================================================
SCORE-WEIGHT SHADOW REPORT  (fix 5)
LOG-ONLY. Never changes a live decision. Replays the exact stored candidate
breakdowns from recent assignments under the live weights AND a candidate
weighting (0.10 shifted from idle onto reliability), and reports how often the
top pick would have differed — with special attention to assignments that
later went bad (reassigned or needed rescheduling). This is the same
"shadow beside the live path" pattern already used for the H3 hub lookup:
observe safely for a few weeks before anyone decides to move a weight.
Runs once per day; the latest snapshot is also stored for the admin panel.
=====================================================
*/
function _shadowScore(candidate, weights) {
  return (
    (Number(candidate.fairnessScore) || 0) * weights.idle +
    (Number(candidate.earningsScore) || 0) * weights.earnings +
    (Number(candidate.distanceScore) || 0) * weights.distance +
    (Number(candidate.skillScore) || 0) * weights.skill +
    (Number(candidate.reliabilityScore) || 0) * weights.reliability
  );
}

function _shadowTopPick(candidates, weights) {
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const s = _shadowScore(c, weights);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

async function runScoreWeightShadow() {
  try {
    const Booking = require("../models/Booking");
    const LearnedStat = require("../models/LearnedStat");
    const { isACBooking } = require("./assignmentEngine");
    const { AC_SCORE_WEIGHTS, GENERAL_SCORE_WEIGHTS } = require("./scheduling_service");
    const cutoff = new Date(Date.now() - SHADOW_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const candidateWeights = (base) => ({
      idle: base.idle - SHADOW_RELIABILITY_SHIFT,
      earnings: base.earnings,
      distance: base.distance,
      skill: base.skill,
      reliability: base.reliability + SHADOW_RELIABILITY_SHIFT,
    });

    const bookings = await Booking.find({
      updatedAt: { $gte: cutoff },
      "assignmentAudit.event": { $in: ["SOFT_ASSIGNED", "CONFIRMED_AUTO"] },
    })
      .select("status assignmentAudit serviceCategory services")
      .limit(SHADOW_MAX_BOOKINGS)
      .lean();

    let analyzed = 0;
    let pickChanged = 0;
    let badOutcome = 0;
    let pickChangedOnBad = 0;
    let reliabilityGainSum = 0; // avg reliabilityScore lift of the candidate pick over the live pick

    for (const b of bookings) {
      const audit = Array.isArray(b.assignmentAudit) ? b.assignmentAudit : [];
      const assignEntry = [...audit]
        .reverse()
        .find((e) => e.event === "SOFT_ASSIGNED" || e.event === "CONFIRMED_AUTO");
      const cands = assignEntry?.candidates || [];
      if (cands.length < 2) continue;
      // Skip pre-deploy audits that lack the full component breakdown.
      const hasComponents = cands.every(
        (c) => Number.isFinite(c.reliabilityScore) && Number.isFinite(c.skillScore)
      );
      if (!hasComponents) continue;

      const base = isACBooking(b) ? AC_SCORE_WEIGHTS : GENERAL_SCORE_WEIGHTS;
      const cand = candidateWeights(base);
      const livePick = _shadowTopPick(cands, base);
      const candPick = _shadowTopPick(cands, cand);
      if (!livePick || !candPick) continue;

      analyzed += 1;
      const changed = String(livePick.partnerId) !== String(candPick.partnerId);
      if (changed) {
        pickChanged += 1;
        reliabilityGainSum +=
          (Number(candPick.reliabilityScore) || 0) - (Number(livePick.reliabilityScore) || 0);
      }

      const reassignCount = audit.filter((e) => e.event === "REASSIGN_REQUESTED").length;
      const bad =
        reassignCount > 0 ||
        ["NEEDS_RESCHEDULING", "NO_PARTNER_AVAILABLE"].includes(b.status);
      if (bad) {
        badOutcome += 1;
        if (changed) pickChangedOnBad += 1;
      }
    }

    const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
    const snapshot = {
      analyzed,
      pickChanged,
      pickChangedPct: pct(pickChanged, analyzed),
      badOutcome,
      pickChangedOnBad,
      pickChangedOnBadPct: pct(pickChangedOnBad, badOutcome),
      avgReliabilityGainOnChange:
        pickChanged > 0 ? Math.round((reliabilityGainSum / pickChanged) * 10) / 10 : 0,
      lookbackDays: SHADOW_LOOKBACK_DAYS,
      reliabilityShift: SHADOW_RELIABILITY_SHIFT,
      generatedAt: new Date().toISOString(),
    };

    if (analyzed > 0) {
      console.log(
        `[shadow] Score-weight report: analyzed=${analyzed} pickChanged=${pickChanged} (${snapshot.pickChangedPct}%) ` +
          `badOutcome=${badOutcome} pickChangedOnBad=${pickChangedOnBad} (${snapshot.pickChangedOnBadPct}%) ` +
          `avgReliabilityGainOnChange=${snapshot.avgReliabilityGainOnChange}`
      );
    }

    await LearnedStat.updateOne(
      { key: "scoreWeightShadow" },
      { $set: { data: snapshot, samples: analyzed } },
      { upsert: true }
    );
  } catch (err) {
    console.error("[cron] runScoreWeightShadow error:", err.message);
  }
}

/*
=====================================================
INIT — called once after MongoDB connects
=====================================================
*/
// Wrap a job so a slow run can never overlap its own next tick. Under load a
// long purge/dispatch could otherwise still be running when setInterval fires
// again, doubling DB work on the single process. The in-flight flag makes the
// second fire a no-op until the first finishes.
function withOverlapGuard(name, fn) {
  let running = false;
  return async function guarded() {
    if (running) {
      if (process.env.NODE_ENV !== "test") {
        console.warn(`[cron] ${name} still running — skipping this tick`);
      }
      return;
    }
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[cron] ${name} error:`, err?.message);
    } finally {
      running = false;
    }
  };
}

function initCronJobs() {
  const jobs = [
    { name: "cancelStaleBookings", fn: cancelStaleBookings, interval: CHECK_INTERVAL_MS },
    { name: "dispatchQueuedBookings", fn: dispatchQueuedBookings, interval: CHECK_INTERVAL_MS },
    { name: "cleanupExpiredSlotLocks", fn: cleanupExpiredSlotLocks, interval: SLOT_LOCK_CHECK_INTERVAL_MS },
    { name: "sendJobReminders", fn: sendJobReminders, interval: REMINDER_INTERVAL_MS },
    { name: "sendCakeOrderReminders", fn: sendCakeOrderReminders, interval: CAKE_REMINDER_INTERVAL_MS },
    { name: "enforceAdvanceAckDeadlines", fn: enforceAdvanceAckDeadlines, interval: REMINDER_INTERVAL_MS },
    { name: "sendHelperInviteReminders", fn: sendHelperInviteReminders, interval: REMINDER_INTERVAL_MS },
    { name: "retryPendingPayouts", fn: retryPendingPayouts, interval: PAYOUT_RETRY_INTERVAL_MS },
    { name: "detectNoShowPartners", fn: detectNoShowPartners, interval: CHECK_INTERVAL_MS },
    { name: "purgeOldPartnerJobHistory", fn: purgeOldPartnerJobHistory, interval: HISTORY_CLEANUP_INTERVAL_MS },
    // Learning loop (fixes 3/4/5) — nightly, log-only for the shadow report.
    { name: "learnServiceDurations", fn: learnServiceDurations, interval: LEARNING_INTERVAL_MS },
    { name: "learnTravelTimes", fn: learnTravelTimes, interval: LEARNING_INTERVAL_MS },
    { name: "runScoreWeightShadow", fn: runScoreWeightShadow, interval: SHADOW_INTERVAL_MS },
  ];

  jobs.forEach((job, i) => {
    const guarded = withOverlapGuard(job.name, job.fn);
    // Stagger the initial catch-up runs a few seconds apart so all ten don't
    // hammer Mongo at once on every process start (thundering herd at boot).
    setTimeout(guarded, i * 3000);
    setInterval(guarded, job.interval);
  });

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
  sendCakeOrderReminders,
  enforceAdvanceAckDeadlines,
  sendHelperInviteReminders,
  retryPendingPayouts,
  detectNoShowPartners,
  purgeOldPartnerJobHistory,
  learnServiceDurations,
  learnTravelTimes,
  runScoreWeightShadow,
};
