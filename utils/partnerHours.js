/*
 * Partner-facing clock rules, in server-local time (the container runs with
 * TZ=Asia/Kolkata — the same convention buildDateTime uses for slots).
 *
 *   Quiet hours 22:00–07:00 — no job alerts ring a partner's phone; jobs
 *     assigned then are announced in the 07:00 morning summary instead. The
 *     working day starts at 09:00, so that always leaves 2h+ of notice.
 *   19:00 — tomorrow's advance bookings are assigned (evening-before dispatch).
 *   20:00 — "Tomorrow: N jobs" summary. 07:00 — "Today: N jobs" summary.
 *
 * Pure functions only (no models) so any service can import them.
 */

const QUIET_HOURS_START = 22;
const QUIET_HOURS_END = 7;
const EVENING_DISPATCH_HOUR = 19;
const EVENING_SUMMARY_HOUR = 20;
const MORNING_SUMMARY_HOUR = 7;
// Morning summaries go out until the working day begins (WORKDAY_START_HOUR).
const MORNING_SUMMARY_UNTIL_HOUR = 9;

function isQuietHours(now = new Date()) {
  const hour = now.getHours();
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Local midnight `days` days after `date`'s own midnight (DST-safe: built from
// calendar fields, not by adding 24h multiples).
function localMidnightPlusDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

// "10:00 AM"-style label for a booking: the slot label the customer picked,
// else the start time formatted.
function jobTimeLabel(booking) {
  const label = String(booking?.scheduledTime || "").trim();
  if (label) return label;
  const start = booking?.scheduledStartAt ? new Date(booking.scheduledStartAt) : null;
  if (!start || Number.isNaN(start.getTime())) return "your scheduled time";
  return start.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
}

function jobServiceLabel(booking) {
  return (
    String(booking?.services?.[0]?.name || "").trim() ||
    String(booking?.serviceCategory || "").trim() ||
    "Service"
  );
}

module.exports = {
  QUIET_HOURS_START,
  QUIET_HOURS_END,
  EVENING_DISPATCH_HOUR,
  EVENING_SUMMARY_HOUR,
  MORNING_SUMMARY_HOUR,
  MORNING_SUMMARY_UNTIL_HOUR,
  isQuietHours,
  startOfLocalDay,
  localMidnightPlusDays,
  localDayKey,
  jobTimeLabel,
  jobServiceLabel,
};
