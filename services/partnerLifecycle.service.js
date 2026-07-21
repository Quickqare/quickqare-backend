/**
 * =====================================================
 * PARTNER LIFECYCLE SERVICE
 *
 * Single source of truth for three things that used to have divergent
 * implementations scattered across the HTTP controllers, the socket handlers,
 * the assignment engine, and the no-show cron:
 *
 *   1. recordPartnerStrike — cancel/reject/no-show reliability strikes with
 *      the daily counter, the rolling-7-day weekly counter (with reset), and
 *      auto-suspension. Previously three variants existed: the HTTP cancel's
 *      atomic pipeline (weekly reset, isBlocked only), the engine's
 *      read-modify-write (NO weekly reset — a stale months-old count plus one
 *      ACK timeout could wrongly suspend a partner — plus suspendedUntil), and
 *      the no-show cron's read-modify-write (no reset, isBlocked only).
 *
 *   2. acceptJobCore — accepting an assigned job. Previously the socket path
 *      set PARTNER_ACCEPTED + ackReceivedAt + cancelled the ACK timer +
 *      incremented activeJobs + pushed the customer, while the HTTP path set
 *      CONFIRMED and did none of that.
 *
 *   3. removeTeamMemberFromBooking — an ADDITIONAL team member backing out.
 *      Previously any team member's cancel/reject released the whole booking
 *      (primary included) back to SEARCHING, destroying a confirmed team over
 *      one member's exit.
 * =====================================================
 */

const Booking = require("../models/Booking");
const Partner = require("../models/Partner");

const PARTNER_DAILY_CANCEL_LIMIT = 1;
const PARTNER_WEEKLY_CANCEL_LIMIT = 5;
const SUSPENSION_DAYS = 7;

/* Local (server-timezone) YYYY-MM-DD — the daily cancel counter previously
   keyed on toISOString() (UTC), which resets at 05:30 IST instead of local
   midnight. Every strike path now shares this one key. */
function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

/**
 * Pre-check (no write): would one more voluntary cancel exceed the partner's
 * daily/weekly allowance? Callers reject the request when it would; the strike
 * itself is only committed via recordPartnerStrike AFTER the booking actually
 * transitioned, so a lost race never costs the partner a strike.
 */
function checkStrikeAllowance(partner, now = new Date()) {
  const dayKey = localDayKey(now);
  const sameDay = partner.lastDailyCancelDate === dayKey;
  const dailyExceeded =
    sameDay && Number(partner.dailyCancelCount || 0) >= PARTNER_DAILY_CANCEL_LIMIT;

  // Epoch default so a null lastCancelReset always triggers a reset rather
  // than comparing against NaN.
  const lastReset = partner.lastCancelReset ? new Date(partner.lastCancelReset) : new Date(0);
  const willResetWeek = (now.getTime() - lastReset.getTime()) / (1000 * 60 * 60 * 24) >= 7;
  const effectiveWeekly = willResetWeek ? 0 : Number(partner.weeklyCancelCount || 0);
  const weeklyExceeded = effectiveWeekly >= PARTNER_WEEKLY_CANCEL_LIMIT;

  return { dailyExceeded, weeklyExceeded, effectiveWeekly };
}

/**
 * Record a reliability strike atomically (single pipeline update — two
 * concurrent strikes can't clobber each other's counters).
 *
 * `strikes` is the weekly weight (e.g. 2 for a post-CONFIRMED cancel — higher
 * customer-trust impact); the daily counter always advances by 1 since it
 * counts cancel EVENTS per calendar day, not weight.
 *
 * Auto-suspension at the weekly limit sets all three flags every path needs:
 * isBlocked (auth gate), isAvailable=false (assignment gate), and
 * suspendedUntil now+7d (auto-expiring exclusion in partner eligibility).
 */
async function recordPartnerStrike(partnerId, { strikes = 1, now = new Date() } = {}) {
  const dayKey = localDayKey(now);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const suspendedUntil = new Date(now.getTime() + SUSPENSION_DAYS * 24 * 60 * 60 * 1000);
  const weeklyResetCond = {
    $gte: [
      { $subtract: [now, { $ifNull: ["$lastCancelReset", new Date(0)] }] },
      weekMs,
    ],
  };
  const overLimitCond = {
    $gte: ["$weeklyCancelCount", PARTNER_WEEKLY_CANCEL_LIMIT],
  };

  const updated = await Partner.findOneAndUpdate(
    { _id: partnerId },
    [
      {
        $set: {
          dailyCancelCount: {
            $cond: [
              { $eq: ["$lastDailyCancelDate", dayKey] },
              { $add: [{ $ifNull: ["$dailyCancelCount", 0] }, 1] },
              1,
            ],
          },
          lastDailyCancelDate: dayKey,
          weeklyCancelCount: {
            $add: [
              { $cond: [weeklyResetCond, 0, { $ifNull: ["$weeklyCancelCount", 0] }] },
              Math.max(Number(strikes) || 1, 1),
            ],
          },
          lastCancelReset: {
            $cond: [weeklyResetCond, now, { $ifNull: ["$lastCancelReset", now] }],
          },
        },
      },
      {
        $set: {
          isBlocked: { $cond: [overLimitCond, true, "$isBlocked"] },
          isAvailable: { $cond: [overLimitCond, false, "$isAvailable"] },
          suspendedUntil: { $cond: [overLimitCond, suspendedUntil, "$suspendedUntil"] },
        },
      },
    ],
    { new: true }
  );

  if (updated && updated.weeklyCancelCount >= PARTNER_WEEKLY_CANCEL_LIMIT) {
    console.warn(
      `[AUTO-SUSPEND] Partner ${partnerId} suspended for ${SUSPENSION_DAYS} days after ${updated.weeklyCancelCount} weekly strikes`
    );
  }

  return updated;
}

/**
 * Accept an assigned job — shared by the socket acceptJob handler and the
 * HTTP POST /api/partner/booking/accept endpoint so the two can never diverge.
 *
 * Only the PRIMARY partner's accept moves the booking to PARTNER_ACCEPTED —
 * an additional team member accepting must not flip the whole booking's state
 * (the primary may still reject or time out, which reassigns the whole team).
 * Their accept is acknowledged as a courtesy no-op.
 */
async function acceptJobCore(bookingId, partnerId) {
  const booking = await Booking.findById(bookingId).select(
    "status partner additionalPartners user ackReceivedAt assignedAt"
  );
  if (!booking) return { ok: false, code: "NOT_FOUND" };

  // First acknowledgement for this assignment? Auto-accept bookings already
  // have ackReceivedAt stamped at assignment time (and acceptedCount bumped
  // in the engine), so a later manual tap must NOT double-count.
  const isFirstAck = !booking.ackReceivedAt;

  const pid = String(partnerId);
  const isPrimary = booking.partner?.toString() === pid;
  const isAdditional = (booking.additionalPartners || []).some(
    (p) => p.toString() === pid
  );
  if (!isPrimary && !isAdditional) return { ok: false, code: "NOT_ASSIGNED" };

  if (!["ASSIGNED", "CONFIRMED"].includes(booking.status)) {
    return { ok: false, code: "NOT_ACCEPTABLE", status: booking.status };
  }

  if (!isPrimary) {
    return { ok: true, isPrimary: false, statusChanged: false, booking };
  }

  // ATOMIC: two accepts (reconnect, second device) — only one wins.
  const accepted = await Booking.findOneAndUpdate(
    { _id: booking._id, status: { $in: ["ASSIGNED", "CONFIRMED"] } },
    {
      $set: {
        status: "PARTNER_ACCEPTED",
        ackReceivedAt: booking.ackReceivedAt ?? new Date(),
      },
    },
    { new: true }
  );
  if (!accepted) return { ok: false, code: "RACE_LOST" };

  try {
    const { cancelAckTimeout } = require("./ackTimeout.service");
    await cancelAckTimeout(booking._id);
  } catch (_) {
    /* DB ackReceivedAt is the canonical safety net */
  }

  // activeJobs always; reliability stats only on the first (real) acceptance.
  const partnerInc = { activeJobs: 1 };
  if (isFirstAck) {
    partnerInc.acceptedCount = 1;
    const assignedAt = booking.assignedAt ? new Date(booking.assignedAt).getTime() : null;
    if (assignedAt) {
      // Cap a single sample at 1h so a partner who accepted a next-day advance
      // job days later doesn't skew the average response time.
      const ackSeconds = Math.min(Math.max(Math.round((Date.now() - assignedAt) / 1000), 0), 3600);
      partnerInc.ackTotalSeconds = ackSeconds;
      partnerInc.ackSampleCount = 1;
    }
  }
  await Partner.updateOne({ _id: partnerId }, { $inc: partnerInc });

  if (global.io) {
    global.io.to(`user_${accepted.user}`).emit("booking_update", {
      bookingId: accepted._id.toString(),
      status: "PARTNER_ACCEPTED",
    });
    global.io.to(`partner_${pid}`).emit("job_accepted_confirmation", {
      bookingId: accepted._id.toString(),
    });
  }

  try {
    const { notifyCustomerOfBookingStatus } = require("./pushNotification.service");
    notifyCustomerOfBookingStatus(accepted.user, "PARTNER_ACCEPTED", accepted._id);
  } catch (_) {
    /* push is best-effort */
  }

  return { ok: true, isPrimary: true, statusChanged: true, booking: accepted };
}

// Statuses in which a team booking is live enough that a member's exit needs
// the removal path (afterwards it's COMPLETED/CANCELLED and moot).
const TEAM_ACTIVE_STATUSES = [
  "ASSIGNED",
  "CONFIRMED",
  "PARTNER_ACCEPTED",
  "ON_THE_WAY",
  "ARRIVED",
  "IN_PROGRESS",
];

/**
 * An ADDITIONAL team member cancels/rejects: remove ONLY them from the booking
 * — the primary partner and the rest of the team keep the job. The dropped
 * member's payout ratio is left unallocated (never silently redistributed);
 * ops is alerted with the exact shortfall so support can arrange a replacement
 * or compensate whoever absorbs the work.
 */
async function removeTeamMemberFromBooking(bookingId, partnerId, reason = "") {
  const now = new Date();
  // Pre-image (new:false) so the dropped allocation is still readable.
  const before = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      additionalPartners: partnerId,
      status: { $in: TEAM_ACTIVE_STATUSES },
    },
    {
      $pull: {
        additionalPartners: partnerId,
        teamAllocations: { partnerId },
      },
      $addToSet: { rejectedPartners: partnerId },
      $push: {
        partnerCancellations: {
          partner: partnerId,
          reason: String(reason || "").trim(),
          cancelledAt: now,
        },
      },
    }
  );

  if (!before) return { removed: false };

  const droppedAllocation = (before.teamAllocations || []).find(
    (a) => a.partnerId?.toString() === String(partnerId)
  );
  const droppedPayoutRatio = Number(droppedAllocation?.payoutRatio || 0);
  const remainingPartners =
    1 + Math.max((before.additionalPartners || []).length - 1, 0);

  // Free the leaving member's calendar; sync rebuilds from committed bookings.
  const { syncPartnerOperationalState } = require("./scheduling_service");
  await syncPartnerOperationalState(partnerId);

  console.warn(
    `[team] Additional partner ${partnerId} left booking ${bookingId} (${before.status}) — ` +
      `${remainingPartners} partner(s) remain, payoutRatio ${droppedPayoutRatio} unallocated. Reason: "${reason}"`
  );

  if (global.io) {
    global.io.to("admin_ops").emit("team_member_dropped", {
      bookingId: String(bookingId),
      partnerId: String(partnerId),
      reason: String(reason || ""),
      statusAtExit: before.status,
      remainingPartners,
      droppedPayoutRatio,
      scheduledDate: before.scheduledDate,
      scheduledTime: before.scheduledTime,
      pincode: before.pincode || "",
      timestamp: now.toISOString(),
    });
  }

  return { removed: true, booking: before, droppedPayoutRatio };
}

module.exports = {
  PARTNER_DAILY_CANCEL_LIMIT,
  PARTNER_WEEKLY_CANCEL_LIMIT,
  localDayKey,
  checkStrikeAllowance,
  recordPartnerStrike,
  acceptJobCore,
  removeTeamMemberFromBooking,
};
