const admin = require("../config/firebase");
const { isQuietHours } = require("../utils/partnerHours");

/* Android notification channel the partner app creates for job alerts
   (high importance, ringtone sound). A device whose app build doesn't have it
   yet falls back to FCM's default channel, so old builds still get the push. */
const JOB_ALERTS_CHANNEL = "job_alerts";

/* FCM error codes that mean the token is permanently invalid (app uninstalled,
   token rotated/expired). When we see one, the stored token is dead — clear it
   so we stop pushing into the void and the device re-registers a fresh one. */
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

/* ── Remove a dead token wherever it is stored (partner or customer) ──
   A partner whose token died has most likely removed the app: pause new jobs
   for them (their next app use un-pauses — see partnerAuth) and tell the team
   about any upcoming jobs they still hold. */
async function clearDeadToken(token) {
  if (!token) return;
  try {
    const Partner = require("../models/Partner");
    const User = require("../models/User");
    const now = new Date();
    const affectedPartners = await Partner.find({ fcmToken: token }).select("_id inactivePausedAt").lean();
    const [partnerRes, userRes] = await Promise.all([
      Partner.updateMany({ fcmToken: token }, { $set: { fcmToken: "" } }),
      User.updateMany({ fcmToken: token }, { $set: { fcmToken: "" } }),
    ]);
    const cleared =
      (partnerRes?.modifiedCount || 0) + (userRes?.modifiedCount || 0);
    if (cleared > 0) {
      console.warn(`[push] cleared dead FCM token from ${cleared} record(s)`);
    }

    for (const p of affectedPartners) {
      if (p.inactivePausedAt) continue;
      const paused = await Partner.findOneAndUpdate(
        { _id: p._id, inactivePausedAt: null },
        { $set: { inactivePausedAt: now, inactivePauseReason: "APP_REMOVED" } },
        { new: true }
      ).lean();
      if (paused) {
        // Lazy: partnerDuty.service requires this module.
        const { alertOpsAboutPausedPartner } = require("./partnerDuty.service");
        await alertOpsAboutPausedPartner(paused, "APP_REMOVED", now);
      }
    }
  } catch (err) {
    console.error("[push] clearDeadToken error:", err.message);
  }
}

/* ── Generic low-level sender ──
   channelId: Android notification channel (JOB_ALERTS_CHANNEL for the loud
   job alerts); omitted → the app's default channel. */
async function sendPush({ token, type, title, body, data = {}, channelId = null }) {
  try {
    if (!token) return;
    if (!admin.apps.length) return; // Firebase not configured

    await admin.messaging().send({
      token,
      notification: { title, body },
      data: {
        type,
        ...Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
      },
      android: {
        priority: "high",
        ...(channelId ? { notification: { channelId } } : {}),
      },
    });
  } catch (err) {
    const code = err?.code || err?.errorInfo?.code || "";
    if (DEAD_TOKEN_CODES.has(code)) {
      await clearDeadToken(token);
    }
    console.error("[push] send error:", err.message);
  }
}

/* ── Generic helper (used by adminComplaint controller) ── */
async function sendPushNotification(token, title, body, data = {}) {
  return sendPush({ token, type: "GENERIC", title, body, data });
}

/* ── Job lifecycle notifications (partner) ──
   New-job alerts ring on the loud channel — but never during quiet hours
   (22:00–07:00): a job assigned at night is announced in the 07:00 morning
   summary instead (partnerDuty.sendMorningSummaries). The app still gets the
   live socket event, so an open app shows the job immediately. */
async function sendJobAssignedPush(token, bookingId, { now = new Date() } = {}) {
  if (isQuietHours(now)) {
    console.log(`[push] quiet hours — job ${bookingId} alert held for the morning summary`);
    return;
  }
  return sendPush({
    token,
    type: "JOB_ASSIGNED",
    title: "New Job Assigned",
    body: "A new job has been assigned to you. Open the app to see the details.",
    data: { bookingId },
    channelId: JOB_ALERTS_CHANNEL,
  });
}

/* ── Partner alerts (summaries, day-of checks, account notices) ──
   loud: true → the job-alerts channel, for things that need action now. */
async function sendPartnerPush(token, { type, title, body, data = {}, loud = false }) {
  return sendPush({
    token,
    type,
    title,
    body,
    data,
    channelId: loud ? JOB_ALERTS_CHANNEL : null,
  });
}

async function sendJobCancelledPush(token, bookingId) {
  return sendPush({
    token,
    type: "JOB_CANCELLED",
    title: "Job Cancelled",
    body: "A job has been cancelled.",
    data: { bookingId },
  });
}

async function sendJobCompletedPush(token, bookingId) {
  return sendPush({
    token,
    type: "JOB_COMPLETED",
    title: "Service Completed",
    body: "Your service has been completed successfully.",
    data: { bookingId },
  });
}

/* ── Customer-facing booking lifecycle notifications ──
   Keyed by event. Most are booking statuses and carry type BOOKING_UPDATE. An
   entry with its own `type` is an event the customer must act on: the app routes
   on it (ESTIMATE_SUBMITTED / GUEST_ADDON_REQUESTED open their approval screens,
   everything else opens the booking). `body` may be a function of the `details`
   the caller passes. */
const CUSTOMER_STATUS_MESSAGES = {
  PARTNER_ACCEPTED: { title: "Partner Confirmed",  body: "A partner has accepted your booking." },
  ON_THE_WAY:       { title: "Partner On The Way", body: "Your partner is heading to your location." },
  ARRIVED:          { title: "Your professional is at your door", body: "They're waiting at your address — please open the door or call them." },
  IN_PROGRESS:      { title: "Service Started",    body: "Your service has started." },
  COMPLETED:        { title: "Service Completed",  body: "Your service is complete — please rate your experience." },
  // Sent by admin force-reschedule and the escalation cron. Tapping the push
  // opens the booking, where the app shows the "Select New Time" action.
  NEEDS_RESCHEDULING: { title: "Action Needed — Reschedule", body: "Your selected time is no longer available. Please pick a new time for your booking." },
  // The booking was closed by someone other than the customer — an admin, the
  // platform (no professional could be found) or the partner at the door. The
  // customer isn't looking at the app when that happens, and wants to know what
  // becomes of their money. Never sent for the customer's own cancellation.
  CANCELLED: {
    title: "Booking cancelled",
    body: ({ refundAmount } = {}) =>
      Number(refundAmount) > 0
        ? `Your booking was cancelled. A refund of ₹${Math.round(Number(refundAmount))} is being processed.`
        : "Your booking was cancelled. Open the app for details.",
  },
  // The technician sent a parts / extra-work estimate that waits for the
  // customer's approval and payment. No amount in the text: what the customer
  // pays includes taxes the estimate doesn't, and the app shows the real figure.
  ESTIMATE_SUBMITTED: {
    type: "ESTIMATE_SUBMITTED",
    title: "Additional work needs your approval",
    body: "Your technician sent an estimate for extra parts or work. Tap to review, approve and pay.",
  },
  // The mehendi artist added guests on the spot; the add-on is its own booking
  // that the customer approves and pays.
  GUEST_ADDON_REQUESTED: {
    type: "GUEST_ADDON_REQUESTED",
    title: "Guest mehendi needs your approval",
    body: ({ guests } = {}) =>
      Number(guests) > 0
        ? `Your artist added ${Number(guests)} guest design${Number(guests) === 1 ? "" : "s"}. Tap to approve and pay.`
        : "Your artist added guest designs. Tap to approve and pay.",
  },
};

async function sendBookingStatusPush(token, status, bookingId, details = {}) {
  const msg = CUSTOMER_STATUS_MESSAGES[status];
  if (!msg) return; // no customer-facing message for this status
  return sendPush({
    token,
    type: msg.type || "BOOKING_UPDATE",
    title: msg.title,
    body: typeof msg.body === "function" ? msg.body(details) : msg.body,
    data: {
      bookingId: String(bookingId),
      // `status` only means something for a booking-status push.
      ...(msg.type ? {} : { status }),
      // A guest add-on is its own booking; this points at the visit it rides on.
      ...(details.parentBookingId ? { parentBookingId: String(details.parentBookingId) } : {}),
    },
  });
}

/*
 * Convenience wrapper for controllers: looks up the customer's fcmToken and
 * pushes a booking notification (`status` is a key of CUSTOMER_STATUS_MESSAGES).
 * `details` feeds the message text: { refundAmount } for CANCELLED, { guests,
 * parentBookingId } for GUEST_ADDON_REQUESTED. Fire-and-forget — it swallows its
 * own errors so a notification failure never breaks a status transition.
 */
async function notifyCustomerOfBookingStatus(userId, status, bookingId, details = {}) {
  try {
    if (!userId) return;
    const User = require("../models/User");
    const user = await User.findById(userId).select("fcmToken").lean();
    if (user?.fcmToken) {
      await sendBookingStatusPush(user.fcmToken, status, bookingId, details);
    }
  } catch (err) {
    console.error("[push] notifyCustomerOfBookingStatus error:", err.message);
  }
}

/*
 * Partner counterpart of notifyCustomerOfBookingStatus: looks up the partner's
 * fcmToken and sends a one-off notification (payout account / withdrawal
 * updates). Fire-and-forget — never throws into the caller.
 */
async function notifyPartner(partnerId, { type, title, body, data = {} }) {
  try {
    if (!partnerId) return;
    const Partner = require("../models/Partner");
    const partner = await Partner.findById(partnerId).select("fcmToken").lean();
    if (partner?.fcmToken) {
      await sendPush({ token: partner.fcmToken, type, title, body, data });
    }
  } catch (err) {
    console.error("[push] notifyPartner error:", err.message);
  }
}

/* ── Promotional broadcast (topic-based) ──
   The customer app subscribes every logged-in device to this FCM topic
   (see project1 src/services/fcm.ts). One send here fans out to all
   subscribed devices — no token iteration, and new installs are covered
   automatically once they log in. Unlike the transactional senders above,
   this THROWS on failure so the admin endpoint can surface the error. */
const PROMO_TOPIC = "promos";

async function sendPromoBroadcast({ title, body, imageUrl }) {
  if (!admin.apps.length) throw new Error("Firebase is not configured on this server");

  return admin.messaging().send({
    topic: PROMO_TOPIC,
    notification: { title, body },
    data: { type: "PROMO" },
    // Promotional traffic is deliberately normal priority — FCM throttles
    // apps that abuse high priority for non-time-sensitive messages.
    android: {
      priority: "normal",
      ...(imageUrl ? { notification: { imageUrl } } : {}),
    },
  });
}

module.exports = {
  JOB_ALERTS_CHANNEL,
  sendPushNotification,
  sendPartnerPush,
  sendJobAssignedPush,
  sendJobCancelledPush,
  sendJobCompletedPush,
  sendBookingStatusPush,
  notifyCustomerOfBookingStatus,
  notifyPartner,
  sendPromoBroadcast,
};
