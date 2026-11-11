/**
 * Free-cancel ("grace") window — a short period after booking in which the
 * customer can cancel for a 100% refund, ahead of the normal refund tiers.
 *
 * Per service (Service.cancellationGrace):
 *   allBookingsWindowMinutes — window every booking gets (0 = off)
 *   windowMinutes + appliesBelowLeadHours — longer window for last-minute
 *     bookings placed with under appliesBelowLeadHours of notice
 *     (appliesBelowLeadHours 0 = the older "applies to every booking" setting)
 *   endsWhenPartnerOnTheWay — the window closes once the professional sets off
 *
 * Global (AdminSetting.cancellation): freeCancelLimit free-window cancels per
 * freeCancelLimitDays — a customer past the limit gets no window on new
 * bookings (0 = no limit).
 *
 * The window is fixed on the booking at creation (freeCancelUntil +
 * freeCancelEndsOnPartnerDeparture) so a later admin change never rewrites
 * what the customer was promised.
 */
const Booking = require("../models/Booking");
const AdminSetting = require("../admin/models/AdminSetting");

const DEFAULT_FREE_CANCEL_LIMIT = 3;
const DEFAULT_FREE_CANCEL_LIMIT_DAYS = 30;

// The professional has set off (or is further along).
const PARTNER_DEPARTED_STATUSES = ["ON_THE_WAY", "ARRIVED", "IN_PROGRESS", "COMPLETED"];

// Most lenient grace across the booked services.
function createGraceCollector() {
  const merged = {
    allBookingsWindowMinutes: 0,
    lastMinuteWindowMinutes: 0,
    lastMinuteThresholdHours: 0, // Infinity = applies to every booking
    // Ends on departure only if every service that grants a window says so.
    endsOnPartnerDeparture: true,
    anyWindow: false,
  };
  const collect = (service) => {
    const g = service?.cancellationGrace || {};
    const all = Math.max(Number(g.allBookingsWindowMinutes) || 0, 0);
    const lastMinute = Math.max(Number(g.windowMinutes) || 0, 0);
    if (all <= 0 && lastMinute <= 0) return;
    merged.anyWindow = true;
    merged.allBookingsWindowMinutes = Math.max(merged.allBookingsWindowMinutes, all);
    if (lastMinute > 0) {
      const threshold = Number(g.appliesBelowLeadHours) || 0;
      merged.lastMinuteWindowMinutes = Math.max(merged.lastMinuteWindowMinutes, lastMinute);
      merged.lastMinuteThresholdHours = Math.max(
        merged.lastMinuteThresholdHours,
        threshold > 0 ? threshold : Infinity
      );
    }
    if (g.endsWhenPartnerOnTheWay === false) merged.endsOnPartnerDeparture = false;
  };
  return { collect, merged };
}

function getFreeCancelLimit(settings) {
  const c = settings?.cancellation || {};
  const limit = c.freeCancelLimit ?? DEFAULT_FREE_CANCEL_LIMIT;
  const days = c.freeCancelLimitDays ?? DEFAULT_FREE_CANCEL_LIMIT_DAYS;
  return {
    limit: Math.max(Number(limit) || 0, 0),
    days: Math.max(Number(days) || 0, 1),
  };
}

async function countRecentFreeCancels(userId, days, now = Date.now()) {
  return Booking.countDocuments({
    user: userId,
    cancelledInFreeWindow: true,
    cancelledAt: { $gte: new Date(now - days * 24 * 60 * 60 * 1000) },
  });
}

/**
 * Booking fields for a new booking: { freeCancelUntil, freeCancelEndsOnPartnerDeparture,
 * freeCancelBlockedByLimit }.
 */
async function computeFreeCancelFields({ merged, scheduledStartAt, userId, settings, now = Date.now() }) {
  const none = {
    freeCancelUntil: null,
    freeCancelEndsOnPartnerDeparture: false,
    freeCancelBlockedByLimit: false,
  };
  if (!merged?.anyWindow) return none;

  let minutes = merged.allBookingsWindowMinutes;
  if (merged.lastMinuteWindowMinutes > 0) {
    const leadHours = (new Date(scheduledStartAt).getTime() - now) / (1000 * 60 * 60);
    if (leadHours < merged.lastMinuteThresholdHours) {
      minutes = Math.max(minutes, merged.lastMinuteWindowMinutes);
    }
  }
  if (minutes <= 0) return none;

  const effectiveSettings = settings === undefined ? await AdminSetting.findOne().lean() : settings;
  const { limit, days } = getFreeCancelLimit(effectiveSettings);
  if (limit > 0 && userId && (await countRecentFreeCancels(userId, days, now)) >= limit) {
    return { ...none, freeCancelBlockedByLimit: true };
  }

  return {
    freeCancelUntil: new Date(now + minutes * 60 * 1000),
    freeCancelEndsOnPartnerDeparture: Boolean(merged.endsOnPartnerDeparture),
    freeCancelBlockedByLimit: false,
  };
}

// Whether a cancel right now falls inside the booking's free-cancel window.
// (ARRIVED is handled separately by the cancel flow — always 0%.)
function isFreeCancelActive(booking, now = Date.now()) {
  if (!booking?.freeCancelUntil) return false;
  if (now > new Date(booking.freeCancelUntil).getTime()) return false;
  if (
    booking.freeCancelEndsOnPartnerDeparture &&
    PARTNER_DEPARTED_STATUSES.includes(booking.status)
  ) {
    return false;
  }
  return true;
}

module.exports = {
  DEFAULT_FREE_CANCEL_LIMIT,
  DEFAULT_FREE_CANCEL_LIMIT_DAYS,
  PARTNER_DEPARTED_STATUSES,
  createGraceCollector,
  getFreeCancelLimit,
  countRecentFreeCancels,
  computeFreeCancelFields,
  isFreeCancelActive,
};
