const admin = require("../config/firebase");

/* =====================================================
   FIREBASE INIT
===================================================== */
// Firebase init is handled in `config/firebase.js` using env vars.

/* =====================================================
   GENERIC PUSH SENDER
===================================================== */
const sendPush = async ({
  token,
  type,
  title,
  body,
  data = {},
}) => {
  try {
    if (!token) return;
    if (!admin.apps.length) return; // Firebase not configured

    await admin.messaging().send({
      token,

      notification: {
        title,
        body,
      },

      data: {
        type,
        ...Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
      },

      android: {
        priority: "high",
      },
    });

    console.log("✅ Push sent:", type);
  } catch (err) {
    console.error("❌ Push error:", err.message);
  }
};

/* =====================================================
   JOB ASSIGNED (NEW SYSTEM)
===================================================== */
exports.sendJobAssignedPush = async (token, bookingId) => {
  return sendPush({
    token,
    type: "JOB_ASSIGNED",
    title: "New Job Assigned",
    body: "A new job has been assigned to you.",
    data: { bookingId },
  });
};

/* =====================================================
   JOB CANCELLED
===================================================== */
exports.sendJobCancelledPush = async (token, bookingId) => {
  return sendPush({
    token,
    type: "JOB_CANCELLED",
    title: "Job Cancelled",
    body: "A job has been cancelled.",
    data: { bookingId },
  });
};

/* =====================================================
   JOB COMPLETED (USER NOTIFICATION)
===================================================== */
exports.sendJobCompletedPush = async (token, bookingId) => {
  return sendPush({
    token,
    type: "JOB_COMPLETED",
    title: "Service Completed",
    body: "Your service has been completed successfully.",
    data: { bookingId },
  });
};
