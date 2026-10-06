/*
 * =====================================================
 * PARTNER DUTY SERVICE
 *
 * Keeps auto-accept practical: a partner never taps to accept a job, so the
 * system has to make sure they KNOW about each job and notices EARLY when one
 * is about to be missed — without making anyone keep the app open.
 *
 *   Summaries        20:00 "Tomorrow: N jobs" · 07:00 "Today: N jobs (K new
 *                    since last night)" — the morning one carries jobs whose
 *                    alert was held back during quiet hours.
 *   Seen signal      the app reports when a job has been on screen (no tap).
 *   Day-of checks    T-60 not seen → urgent alert + team · T-15 not on the way
 *                    → "time to leave" nudge · T+20 not on the way → partner +
 *                    team. (T+2h no-show → reschedule lives in cron.service.)
 *   Inactivity pause no app use for INACTIVITY_PAUSE_DAYS (or app removed) →
 *                    no new jobs until they next open the app.
 *   Urgent switch    isOnline ("Available for urgent jobs") is switched off
 *                    every night; it only gates jobs starting within 30 min.
 *   Suspensions      strike suspensions lift by themselves.
 *
 * Every cron function takes `now` so tests can drive the clock.
 * =====================================================
 */

const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const BookingTimeline = require("../admin/models/BookingTimeline");
const { sendPartnerPush } = require("./pushNotification.service");
const { alertOps } = require("./opsAlert.service");
const {
  PARTNER_DAILY_CANCEL_LIMIT,
  PARTNER_WEEKLY_CANCEL_LIMIT,
  FREE_RELEASE_MIN_HOURS,
  FREE_RELEASES_PER_WEEK,
  checkStrikeAllowance,
  freeReleasesLeft,
} = require("./partnerLifecycle.service");
const {
  QUIET_HOURS_START,
  EVENING_SUMMARY_HOUR,
  MORNING_SUMMARY_HOUR,
  MORNING_SUMMARY_UNTIL_HOUR,
  isQuietHours,
  startOfLocalDay,
  localMidnightPlusDays,
  localDayKey,
  jobTimeLabel,
  jobServiceLabel,
} = require("../utils/partnerHours");

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const INACTIVITY_PAUSE_DAYS = 3;
const UNSEEN_ALERT_MINUTES = 60;
const LEAVE_NUDGE_MINUTES = 15;
const LATE_ALERT_MINUTES = 20;
// The T+20 late check only looks back this far — older bookings belong to the
// no-show cron (T+2h), and this bound stops a deploy from alerting on history.
const LATE_ALERT_LOOKBACK_MINUTES = 120;

// Booking fields that belong to the CURRENT assignment — cleared whenever the
// booking gets a new partner (engine assign, reassign, admin assign). A
// function so every $set gets its own fresh array.
function dutyStateReset() {
  return {
    partnerSeen: [],
    unseenAlertSentAt: null,
    leaveNudgeSentAt: null,
    lateStartAlertSentAt: null,
    preJobReminderSentAt: null,
  };
}

// Booked and waiting for the partner to set off.
const UPCOMING_JOB_STATUSES = ["ASSIGNED", "CONFIRMED", "PARTNER_ACCEPTED"];
// Seen signal applies to any job the partner still has in front of them.
const SEEN_TRACKED_STATUSES = [
  "ASSIGNED",
  "CONFIRMED",
  "PARTNER_ACCEPTED",
  "ON_THE_WAY",
  "ARRIVED",
  "IN_PROGRESS",
];

const JOB_FIELDS =
  "_id partner additionalPartners scheduledStartAt scheduledTime services serviceCategory pincode assignedAt partnerSeen user";

function assignedPartnerIds(booking) {
  return [booking.partner, ...(booking.additionalPartners || [])]
    .filter(Boolean)
    .map((id) => String(id));
}

function pluralJobs(count) {
  return `${count} job${count === 1 ? "" : "s"}`;
}

function bookingLine(booking) {
  const start = booking.scheduledStartAt ? new Date(booking.scheduledStartAt) : null;
  const day = start
    ? start.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })
    : "";
  return `${day} ${jobTimeLabel(booking)} — ${jobServiceLabel(booking)} (pincode ${booking.pincode || "-"}, booking ${booking._id})`;
}

function partnerLine(partner) {
  return `${partner?.name || "Partner"} (${partner?.phone || "no phone"})`;
}

/* =====================================================
   SUMMARIES
===================================================== */

// partnerId → [booking] for jobs starting in [from, to), earliest first.
async function jobsByPartner(from, to) {
  const bookings = await Booking.find({
    status: { $in: UPCOMING_JOB_STATUSES },
    scheduledStartAt: { $gte: from, $lt: to },
    partner: { $ne: null },
  })
    .select(JOB_FIELDS)
    .sort({ scheduledStartAt: 1 })
    .lean();

  const byPartner = new Map();
  for (const booking of bookings) {
    for (const pid of assignedPartnerIds(booking)) {
      if (!byPartner.has(pid)) byPartner.set(pid, []);
      byPartner.get(pid).push(booking);
    }
  }
  return byPartner;
}

// Claim the partner's summary for `dayKey` (field = eveningSummaryFor /
// morningSummaryFor) so it goes out once even with overlapping cron runs.
async function claimSummary(partnerId, field, dayKey) {
  return Partner.findOneAndUpdate(
    { _id: partnerId, [field]: { $ne: dayKey } },
    { $set: { [field]: dayKey } },
    { new: true }
  )
    .select("_id fcmToken")
    .lean();
}

/** 20:00–22:00: "Tomorrow: N jobs, first at …" to every partner with jobs tomorrow. */
async function sendEveningSummaries(now = new Date()) {
  const hour = now.getHours();
  if (hour < EVENING_SUMMARY_HOUR || hour >= QUIET_HOURS_START) return 0;

  const tomorrow = localMidnightPlusDays(now, 1);
  const dayAfter = localMidnightPlusDays(now, 2);
  const dayKey = localDayKey(tomorrow);
  const byPartner = await jobsByPartner(tomorrow, dayAfter);

  let sent = 0;
  for (const [partnerId, jobs] of byPartner) {
    const claimed = await claimSummary(partnerId, "eveningSummaryFor", dayKey);
    if (!claimed?.fcmToken) continue;
    const first = jobs[0];
    await sendPartnerPush(claimed.fcmToken, {
      type: "JOB_SUMMARY",
      title: `Tomorrow: ${pluralJobs(jobs.length)}`,
      body: `First at ${jobTimeLabel(first)} — ${jobServiceLabel(first)}. Open the app to see your schedule.`,
      data: { date: dayKey },
    });
    sent += 1;
  }
  if (sent) console.log(`[duty] Sent ${sent} evening summary(ies) for ${dayKey}`);
  return sent;
}

/**
 * 07:00–09:00: "Today: N jobs" — including jobs assigned overnight, whose
 * new-job alert was held back by quiet hours ("K new since last night").
 */
async function sendMorningSummaries(now = new Date()) {
  const hour = now.getHours();
  if (hour < MORNING_SUMMARY_HOUR || hour >= MORNING_SUMMARY_UNTIL_HOUR) return 0;

  const today = startOfLocalDay(now);
  const tomorrow = localMidnightPlusDays(now, 1);
  const dayKey = localDayKey(today);
  // Quiet hours began at 22:00 yesterday.
  const quietStart = new Date(today.getTime() - (24 - QUIET_HOURS_START) * HOUR_MS);
  const byPartner = await jobsByPartner(today, tomorrow);

  let sent = 0;
  for (const [partnerId, jobs] of byPartner) {
    const claimed = await claimSummary(partnerId, "morningSummaryFor", dayKey);
    if (!claimed?.fcmToken) continue;
    const first = jobs[0];
    const newOvernight = jobs.filter(
      (b) => b.assignedAt && new Date(b.assignedAt) >= quietStart
    ).length;
    await sendPartnerPush(claimed.fcmToken, {
      type: "JOB_SUMMARY",
      title: `Today: ${pluralJobs(jobs.length)}`,
      body:
        `First at ${jobTimeLabel(first)} — ${jobServiceLabel(first)}.` +
        (newOvernight ? ` ${newOvernight} new since last night.` : ""),
      data: { date: dayKey },
    });
    sent += 1;
  }
  if (sent) console.log(`[duty] Sent ${sent} morning summary(ies) for ${dayKey}`);
  return sent;
}

/* =====================================================
   SEEN SIGNAL
===================================================== */

/**
 * Record that the partner's app showed them these jobs. Only bookings they are
 * assigned to (primary or team) and still working count; repeats are no-ops.
 * Also marks the partner's app as sending the signal (seenSignalAt), which
 * switches on the "not seen" check for them. Returns how many were new.
 */
async function markJobsSeen(partnerId, bookingIds, now = new Date()) {
  const pid = String(partnerId);
  const filter = {
    _id: { $in: bookingIds },
    $or: [{ partner: partnerId }, { additionalPartners: partnerId }],
    status: { $in: SEEN_TRACKED_STATUSES },
    "partnerSeen.partnerId": { $ne: partnerId },
  };

  const toMark = await Booking.find(filter).select("_id").lean();
  if (toMark.length) {
    const ids = toMark.map((b) => b._id);
    await Booking.updateMany(
      { ...filter, _id: { $in: ids } },
      { $push: { partnerSeen: { partnerId, seenAt: now } } }
    );
    try {
      await BookingTimeline.insertMany(
        ids.map((bookingId) => ({
          bookingId,
          eventType: "PARTNER_SEEN",
          payload: JSON.stringify({ partnerId: pid }),
        }))
      );
    } catch (err) {
      console.error("[duty] PARTNER_SEEN timeline write failed:", err.message);
    }
  }

  await Partner.updateOne({ _id: partnerId, seenSignalAt: null }, { $set: { seenSignalAt: now } });
  return toMark.length;
}

/* =====================================================
   DAY-OF CHECKS
===================================================== */

// Atomically take a booking's one-shot flag; null when another run got it.
function claimBookingFlag(bookingId, flag, now) {
  return Booking.findOneAndUpdate(
    { _id: bookingId, [flag]: null },
    { $set: { [flag]: now } },
    { new: true }
  ).lean();
}

async function loadPartners(ids) {
  if (!ids.length) return [];
  return Partner.find({ _id: { $in: ids } })
    .select("_id name phone fcmToken seenSignalAt")
    .lean();
}

/** T-60: jobs starting within the hour that an assigned partner hasn't seen. */
async function checkUnseenJobs(now = new Date()) {
  const bookings = await Booking.find({
    status: { $in: UPCOMING_JOB_STATUSES },
    scheduledStartAt: { $gt: now, $lte: new Date(now.getTime() + UNSEEN_ALERT_MINUTES * MINUTE_MS) },
    unseenAlertSentAt: null,
    partner: { $ne: null },
  })
    .select(JOB_FIELDS)
    .lean();

  let alerted = 0;
  for (const booking of bookings) {
    const claimed = await claimBookingFlag(booking._id, "unseenAlertSentAt", now);
    if (!claimed) continue;

    const seen = new Set((claimed.partnerSeen || []).map((s) => String(s.partnerId)));
    const partners = await loadPartners(assignedPartnerIds(claimed));
    // Only partners whose app sends the seen signal can be judged "not seen".
    const unseen = partners.filter((p) => p.seenSignalAt && !seen.has(String(p._id)));
    if (!unseen.length) continue;

    const time = jobTimeLabel(claimed);
    const service = jobServiceLabel(claimed);
    for (const partner of unseen) {
      if (!partner.fcmToken) continue;
      await sendPartnerPush(partner.fcmToken, {
        type: "JOB_UNSEEN_ALERT",
        loud: true,
        title: "Job starting in 1 hour",
        body: `Your ${time} job (${service}) starts soon and you haven't opened it yet. Open the app now.`,
        data: { bookingId: String(claimed._id) },
      });
    }

    await alertOps({
      event: "partner_job_not_seen",
      timelineEvent: "PARTNER_NOT_SEEN",
      bookingIds: [claimed._id],
      subject: `Job at ${time} not seen by the partner yet`,
      lines: [
        `Partner hasn't opened this job and it starts within the hour: ${unseen.map(partnerLine).join(", ")}.`,
        bookingLine(claimed),
        "Call the partner, or reassign the booking from the admin panel.",
      ],
      data: { bookingId: String(claimed._id), partnerIds: unseen.map((p) => String(p._id)) },
    });
    alerted += 1;
  }
  return alerted;
}

/** T-15: not on the way yet → "time to leave" nudge to every assigned partner. */
async function nudgeLeaveTime(now = new Date()) {
  const bookings = await Booking.find({
    status: { $in: ["CONFIRMED", "PARTNER_ACCEPTED"] },
    scheduledStartAt: { $gt: now, $lte: new Date(now.getTime() + LEAVE_NUDGE_MINUTES * MINUTE_MS) },
    leaveNudgeSentAt: null,
    partner: { $ne: null },
  })
    .select(JOB_FIELDS)
    .lean();

  let nudged = 0;
  for (const booking of bookings) {
    const claimed = await claimBookingFlag(booking._id, "leaveNudgeSentAt", now);
    if (!claimed) continue;
    const partners = await loadPartners(assignedPartnerIds(claimed));
    for (const partner of partners) {
      if (!partner.fcmToken) continue;
      await sendPartnerPush(partner.fcmToken, {
        type: "JOB_LEAVE_NUDGE",
        title: "Time to leave",
        body: `Your ${jobTimeLabel(claimed)} job starts in about ${LEAVE_NUDGE_MINUTES} minutes. Tap "On the way" when you leave.`,
        data: { bookingId: String(claimed._id) },
      });
    }
    nudged += 1;
  }
  return nudged;
}

/** T+20: start time passed and nobody is on the way → partner + team alert. */
async function alertLateStarts(now = new Date()) {
  const bookings = await Booking.find({
    status: { $in: UPCOMING_JOB_STATUSES },
    scheduledStartAt: {
      $gte: new Date(now.getTime() - LATE_ALERT_LOOKBACK_MINUTES * MINUTE_MS),
      $lte: new Date(now.getTime() - LATE_ALERT_MINUTES * MINUTE_MS),
    },
    lateStartAlertSentAt: null,
    partner: { $ne: null },
  })
    .select(JOB_FIELDS)
    .lean();

  let alerted = 0;
  for (const booking of bookings) {
    const claimed = await claimBookingFlag(booking._id, "lateStartAlertSentAt", now);
    if (!claimed) continue;
    const partners = await loadPartners(assignedPartnerIds(claimed));
    const time = jobTimeLabel(claimed);

    for (const partner of partners) {
      if (!partner.fcmToken) continue;
      await sendPartnerPush(partner.fcmToken, {
        type: "JOB_LATE_ALERT",
        loud: true,
        title: "You're late for a job",
        body: `Your ${time} job has started without you. Tap "On the way" now, or call support if you can't make it.`,
        data: { bookingId: String(claimed._id) },
      });
    }

    await alertOps({
      event: "partner_late",
      timelineEvent: "PARTNER_LATE",
      bookingIds: [claimed._id],
      subject: `Partner not on the way — ${time} job`,
      lines: [
        `${LATE_ALERT_MINUTES}+ minutes past the start time and nobody has tapped "On the way": ${
          partners.map(partnerLine).join(", ") || "partner"
        }.`,
        bookingLine(claimed),
        "Call the partner, or reassign the booking from the admin panel. If nothing changes, it moves to rescheduling 2 hours after the start.",
      ],
      data: { bookingId: String(claimed._id), status: claimed.status },
    });
    alerted += 1;
  }
  return alerted;
}

/** Runs the three day-of checks (every 5 minutes). */
async function runDayOfChecks(now = new Date()) {
  const unseen = await checkUnseenJobs(now);
  const nudged = await nudgeLeaveTime(now);
  const late = await alertLateStarts(now);
  if (unseen || nudged || late) {
    console.log(`[duty] Day-of checks: ${unseen} not-seen alert(s), ${nudged} leave nudge(s), ${late} late alert(s)`);
  }
  return { unseen, nudged, late };
}

/* =====================================================
   INACTIVITY PAUSE
===================================================== */

const PAUSE_REASON_TEXT = {
  INACTIVE: `hasn't opened the partner app for ${INACTIVITY_PAUSE_DAYS}+ days`,
  APP_REMOVED: "appears to have removed the partner app (push notifications stopped working)",
};

/** Tell the team about upcoming jobs a paused partner still holds. */
async function alertOpsAboutPausedPartner(partner, reason, now = new Date()) {
  const jobs = await Booking.find({
    $or: [{ partner: partner._id }, { additionalPartners: partner._id }],
    status: { $in: UPCOMING_JOB_STATUSES },
    scheduledStartAt: { $gt: now },
  })
    .select(JOB_FIELDS)
    .sort({ scheduledStartAt: 1 })
    .limit(20)
    .lean();
  if (!jobs.length) return 0;

  await alertOps({
    event: "partner_paused",
    timelineEvent: "PARTNER_PAUSED",
    bookingIds: jobs.map((b) => b._id),
    subject: `Partner paused with ${pluralJobs(jobs.length)} upcoming: ${partner.name || "Partner"}`,
    lines: [
      `${partnerLine(partner)} ${PAUSE_REASON_TEXT[reason] || "was paused"}. They get no new jobs until they open the app again.`,
      "They still hold these jobs — check they'll do them, or reassign:",
      ...jobs.map(bookingLine),
    ],
    data: { partnerId: String(partner._id), reason, bookingIds: jobs.map((b) => String(b._id)) },
  });
  return jobs.length;
}

/**
 * Pause new jobs for approved partners who haven't used the app for
 * INACTIVITY_PAUSE_DAYS. Activity = the latest of lastActiveAt (any app API
 * call), lastOnlineAt (login / push-token sync) and lastLocationAt. Skipped
 * during quiet hours so the "paused" notice never lands at night.
 */
async function pauseInactivePartners(now = new Date()) {
  if (isQuietHours(now)) return 0;
  const cutoff = new Date(now.getTime() - INACTIVITY_PAUSE_DAYS * 24 * HOUR_MS);
  const idleOrMissing = (field) => ({ $or: [{ [field]: null }, { [field]: { $lt: cutoff } }] });

  const candidates = await Partner.find({
    approvalStatus: "APPROVED",
    isBlocked: false,
    isDeleted: { $ne: true },
    inactivePausedAt: null,
    createdAt: { $lt: cutoff },
    $and: [idleOrMissing("lastActiveAt"), idleOrMissing("lastOnlineAt"), idleOrMissing("lastLocationAt")],
  })
    .select("_id name phone fcmToken")
    .limit(500)
    .lean();

  let paused = 0;
  for (const partner of candidates) {
    const updated = await Partner.findOneAndUpdate(
      { _id: partner._id, inactivePausedAt: null },
      { $set: { inactivePausedAt: now, inactivePauseReason: "INACTIVE" } }
    );
    if (!updated) continue;
    paused += 1;

    if (partner.fcmToken) {
      await sendPartnerPush(partner.fcmToken, {
        type: "ACCOUNT_PAUSED",
        title: "New jobs paused",
        body: `You haven't opened QuickQare Partner for ${INACTIVITY_PAUSE_DAYS} days, so we've paused new jobs. Open the app to start getting jobs again.`,
      });
    }
    await alertOpsAboutPausedPartner(partner, "INACTIVE", now);
  }
  if (paused) console.log(`[duty] Paused ${paused} inactive partner(s)`);
  return paused;
}

/* =====================================================
   URGENT-JOBS SWITCH + SUSPENSIONS
===================================================== */

/**
 * isOnline is the partner's "Available for urgent jobs" switch — it only gates
 * bookings starting within 30 minutes. It is switched off every night so a
 * partner never stays "available" while asleep; they switch it on in the
 * morning. Runs through quiet hours, so a night-time login is reset too.
 */
async function resetUrgentAvailabilityAtNight(now = new Date()) {
  if (!isQuietHours(now)) return 0;
  const result = await Partner.updateMany({ isOnline: true }, { $set: { isOnline: false } });
  const count = result?.modifiedCount || 0;
  if (count) console.log(`[duty] Night reset: urgent-jobs switch turned off for ${count} partner(s)`);
  return count;
}

/** End strike suspensions whose date has passed (new jobs resume). */
async function liftExpiredSuspensions(now = new Date()) {
  const due = await Partner.find({
    isAvailable: false,
    suspendedUntil: { $ne: null, $lte: now },
  })
    .select("_id fcmToken")
    .lean();
  if (!due.length) return 0;

  await Partner.updateMany(
    { _id: { $in: due.map((p) => p._id) }, suspendedUntil: { $ne: null, $lte: now } },
    { $set: { isAvailable: true, suspendedUntil: null } }
  );
  if (!isQuietHours(now)) {
    for (const partner of due) {
      if (!partner.fcmToken) continue;
      await sendPartnerPush(partner.fcmToken, {
        type: "ACCOUNT_RESUMED",
        title: "You can get new jobs again",
        body: "Your pause has ended. Keep your cancellations low to keep getting jobs.",
      });
    }
  }
  console.log(`[duty] Lifted ${due.length} expired suspension(s)`);
  return due.length;
}

/* =====================================================
   STANDING (shown in the partner app)
===================================================== */

function computePartnerStanding(partner, now = new Date()) {
  const { effectiveWeekly } = checkStrikeAllowance(partner, now);
  const cancelledToday =
    partner.lastDailyCancelDate === localDayKey(now) ? Number(partner.dailyCancelCount || 0) : 0;
  const suspendedUntil =
    partner.suspendedUntil && new Date(partner.suspendedUntil) > now ? partner.suspendedUntil : null;

  return {
    cancellationsThisWeek: effectiveWeekly,
    weeklyCancelLimit: PARTNER_WEEKLY_CANCEL_LIMIT,
    cancelledToday,
    dailyCancelLimit: PARTNER_DAILY_CANCEL_LIMIT,
    freeReleasesLeft: freeReleasesLeft(partner, now),
    freeReleasesPerWeek: FREE_RELEASES_PER_WEEK,
    freeReleaseMinHours: FREE_RELEASE_MIN_HOURS,
    newJobsPausedUntil: suspendedUntil,
  };
}

module.exports = {
  dutyStateReset,
  INACTIVITY_PAUSE_DAYS,
  UNSEEN_ALERT_MINUTES,
  LEAVE_NUDGE_MINUTES,
  LATE_ALERT_MINUTES,
  sendEveningSummaries,
  sendMorningSummaries,
  markJobsSeen,
  checkUnseenJobs,
  nudgeLeaveTime,
  alertLateStarts,
  runDayOfChecks,
  alertOpsAboutPausedPartner,
  pauseInactivePartners,
  resetUrgentAvailabilityAtNight,
  liftExpiredSuspensions,
  computePartnerStanding,
};
