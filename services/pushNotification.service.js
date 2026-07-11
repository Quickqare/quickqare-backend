const admin = require("../config/firebase");

/* FCM error codes that mean the token is permanently invalid (app uninstalled,
   token rotated/expired). When we see one, the stored token is dead — clear it
   so we stop pushing into the void and the device re-registers a fresh one. */
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

/* ── Remove a dead token wherever it is stored (partner or customer) ── */
async function clearDeadToken(token) {
  if (!token) return;
  try {
    const Partner = require("../models/Partner");
    const User = require("../models/User");
    const [partnerRes, userRes] = await Promise.all([
      Partner.updateMany({ fcmToken: token }, { $set: { fcmToken: "" } }),
      User.updateMany({ fcmToken: token }, { $set: { fcmToken: "" } }),
    ]);
    const cleared =
      (partnerRes?.modifiedCount || 0) + (userRes?.modifiedCount || 0);
    if (cleared > 0) {
      console.warn(`[push] cleared dead FCM token from ${cleared} record(s)`);
    }
  } catch (err) {
    console.error("[push] clearDeadToken error:", err.message);
  }
}

/* ── Generic low-level sender ── */
async function sendPush({ token, type, title, body, data = {} }) {
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
      android: { priority: "high" },
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

/* ── Job lifecycle notifications (partner) ── */
async function sendJobAssignedPush(token, bookingId) {
  return sendPush({
    token,
    type: "JOB_ASSIGNED",
    title: "New Job Assigned",
    body: "A new job has been assigned to you.",
    data: { bookingId },
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

/* ── Customer-facing booking lifecycle notifications ── */
const CUSTOMER_STATUS_MESSAGES = {
  PARTNER_ACCEPTED: { title: "Partner Confirmed",  body: "A partner has accepted your booking." },
  ON_THE_WAY:       { title: "Partner On The Way", body: "Your partner is heading to your location." },
  ARRIVED:          { title: "Partner Arrived",    body: "Your partner has arrived at your location." },
  IN_PROGRESS:      { title: "Service Started",    body: "Your service has started." },
  COMPLETED:        { title: "Service Completed",  body: "Your service is complete — please rate your experience." },
  // Sent by admin force-reschedule and the escalation cron. Tapping the push
  // opens the booking, where the app shows the "Select New Time" action.
  NEEDS_RESCHEDULING: { title: "Action Needed — Reschedule", body: "Your selected time is no longer available. Please pick a new time for your booking." },
};

async function sendBookingStatusPush(token, status, bookingId) {
  const msg = CUSTOMER_STATUS_MESSAGES[status];
  if (!msg) return; // no customer-facing message for this status
  return sendPush({
    token,
    type: "BOOKING_UPDATE",
    title: msg.title,
    body: msg.body,
    data: { bookingId: String(bookingId), status },
  });
}

/*
 * Convenience wrapper for controllers: looks up the customer's fcmToken and
 * pushes a booking-status notification. Fire-and-forget — it swallows its own
 * errors so a notification failure never breaks a status transition.
 */
async function notifyCustomerOfBookingStatus(userId, status, bookingId) {
  try {
    if (!userId) return;
    const User = require("../models/User");
    const user = await User.findById(userId).select("fcmToken").lean();
    if (user?.fcmToken) {
      await sendBookingStatusPush(user.fcmToken, status, bookingId);
    }
  } catch (err) {
    console.error("[push] notifyCustomerOfBookingStatus error:", err.message);
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
  sendPushNotification,
  sendJobAssignedPush,
  sendJobCancelledPush,
  sendJobCompletedPush,
  sendBookingStatusPush,
  notifyCustomerOfBookingStatus,
  sendPromoBroadcast,
};
