const admin = require("../config/firebase");

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

module.exports = {
  sendPushNotification,
  sendJobAssignedPush,
  sendJobCancelledPush,
  sendJobCompletedPush,
};
