/*
 * Team (ops) alerts.
 *
 * The admin panel has no live socket feed — nothing ever joins the
 * "admin_ops" room — so an alert that is only emitted there reaches nobody.
 * alertOps therefore delivers each alert three ways:
 *
 *   1. a BookingTimeline entry on every affected booking, shown in the admin
 *      booking detail's Timeline section (no admin UI change needed);
 *   2. an email to OPS_ALERT_EMAILS (comma-separated) via Resend, when both it
 *      and RESEND_API_KEY are set — otherwise the alert is logged;
 *   3. the admin_ops socket event, for a future live feed.
 *
 * Never throws: alerting must not break the job flow that triggered it.
 */

const BookingTimeline = require("../admin/models/BookingTimeline");

function opsAlertRecipients() {
  return String(process.env.OPS_ALERT_EMAILS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function alertOps({
  event,
  timelineEvent = null,
  bookingIds = [],
  subject,
  lines = [],
  data = {},
}) {
  if (timelineEvent && bookingIds.length) {
    try {
      await BookingTimeline.insertMany(
        bookingIds.map((bookingId) => ({
          bookingId,
          eventType: timelineEvent,
          payload: JSON.stringify(data),
        }))
      );
    } catch (err) {
      console.error(`[ops-alert] timeline write failed (${event}):`, err.message);
    }
  }

  if (global.io) {
    global.io.to("admin_ops").emit(event, { ...data, timestamp: new Date().toISOString() });
  }

  const recipients = opsAlertRecipients();
  if (!recipients.length || !process.env.RESEND_API_KEY) {
    console.warn(`[ops-alert] ${subject} — ${lines.join(" | ")}`);
    return;
  }

  try {
    // Lazy: the email service constructs its Resend client at load and throws
    // without RESEND_API_KEY.
    const { sendOpsAlertEmail } = require("../admin/services/email.service");
    await sendOpsAlertEmail(recipients, subject, lines);
  } catch (err) {
    console.error(`[ops-alert] email failed (${event}):`, err.message);
  }
}

module.exports = { alertOps, opsAlertRecipients };
