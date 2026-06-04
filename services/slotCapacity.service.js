const Booking = require("../models/Booking");
const SlotCapacity = require("../models/SlotCapacity");
const SlotLock = require("../models/SlotLock");
const { computeRequiredPartners } = require("./assignmentEngine");
const { resolveZoneForPincode, getZoneCoveragePincodes } = require("./zone.service");

const SLOT_LOCK_MINUTES = 10;

function getSchedulingService() {
  return require("./scheduling_service");
}

/*
=====================================================
CAPACITY SCOPE
Partners are shared across every pincode a zone covers, so capacity must be
counted and reserved per ZONE — not per raw pincode. Keying by pincode let each
pincode reserve the full shared pool independently, oversubscribing the zone.

Returns a stable per-zone key (so all pincodes in the zone share one counter)
plus the zone's coverage pincodes (used to count only partners who actually
serve this zone). Unzoned pincodes — which cannot take bookings anyway — fall
back to per-pincode scope, preserving the previous behaviour.
=====================================================
*/
async function resolveCapacityScope(pincode) {
  const raw = String(pincode || "").trim();
  const zone = await resolveZoneForPincode(raw);
  if (!zone) {
    return { scopeKey: raw, coveragePincodes: raw ? [raw] : [] };
  }
  const coveragePincodes = getZoneCoveragePincodes(zone);
  return {
    scopeKey: `zone:${String(zone._id)}`,
    coveragePincodes: coveragePincodes.length ? coveragePincodes : raw ? [raw] : [],
  };
}

function normalizeDateKey(dateInput) {
  const date = new Date(dateInput);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

function getTimeLabel(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function buildSlotWindows(startAt, endAt) {
  const { SLOT_GAP_MINUTES, addMinutes } = getSchedulingService();
  const windows = [];
  for (let cursor = new Date(startAt); cursor < endAt; cursor = addMinutes(cursor, SLOT_GAP_MINUTES)) {
    const slotStart = new Date(cursor);
    const slotEnd = addMinutes(slotStart, SLOT_GAP_MINUTES);
    windows.push({
      slotStart,
      slotEnd,
      dateKey: normalizeDateKey(slotStart),
      time: getTimeLabel(slotStart),
    });
  }
  return windows;
}

function buildSlotKey(pincode, dateKey, time) {
  return `${String(pincode || "").trim()}:${dateKey}:${time}`;
}

function buildBookingWindow(booking) {
  const { buildDateTime } = getSchedulingService();
  const startAt = booking?.scheduledStartAt
    ? new Date(booking.scheduledStartAt)
    : buildDateTime(booking.scheduledDate, booking.scheduledTime);
  const durationMinutes = Math.max(Number(booking?.estimatedDurationMinutes) || 60, 1);
  const endAt = booking?.scheduledEndAt
    ? new Date(booking.scheduledEndAt)
    : new Date(startAt.getTime() + durationMinutes * 60 * 1000);
  return { startAt, endAt, durationMinutes };
}

async function getEligibleUnitsForWindow(booking, slotStart, slotEnd, coveragePincodes, session) {
  const { findEligiblePartnersForBooking } = getSchedulingService();

  const candidates = await findEligiblePartnersForBooking(
    {
      services: booking.services || [],
      serviceId: booking.serviceId || null,
      serviceCategory: booking.serviceCategory || "",
      scheduledDate: booking.scheduledDate,
      scheduledTime: booking.scheduledTime,
      scheduledStartAt: slotStart,
      scheduledEndAt: slotEnd,
      estimatedDurationMinutes: booking.estimatedDurationMinutes,
      location: booking.location,
      pincode: booking.pincode,
      rejectedPartners: booking.rejectedPartners || [],
    },
    // 2nd arg is the pincode-stage filter. Pass the zone's coverage pincodes so
    // the count reflects partners who actually serve THIS zone (the same reach
    // as the assignment engine's widest stage) — not every partner in the system.
    // rejectedPartners is read from the booking object above, not from here.
    coveragePincodes,
    { requireOnline: false, session }
  );

  return candidates.length;
}

async function getSlotAvailabilitySnapshot(booking, slotStart, slotEnd, session) {
  const requiredCount = Math.max(Number((await computeRequiredPartners(booking))?.requiredCount) || 1, 1);
  const { scopeKey, coveragePincodes } = await resolveCapacityScope(booking.pincode);
  const eligibleUnits = await getEligibleUnitsForWindow(booking, slotStart, slotEnd, coveragePincodes, session);
  const dateKey = normalizeDateKey(slotStart);
  const time = getTimeLabel(slotStart);
  // Key capacity by zone (not raw pincode) so every pincode the zone covers
  // shares ONE counter — otherwise each pincode reserves the full shared pool
  // independently and the slot is oversold.
  const slotKey = buildSlotKey(scopeKey, dateKey, time);

  const capacity = await SlotCapacity.findOneAndUpdate(
    { slotKey },
    {
      $setOnInsert: {
        slotKey,
        reservedUnits: 0,
      },
      $set: {
        pincode: String(booking.pincode || "").trim(),
        dateKey,
        time,
        totalUnits: eligibleUnits,
        updatedAt: new Date(),
      },
    },
    { new: true, upsert: true, session }
  );

  const availableUnits = Math.max(Number(capacity?.totalUnits || eligibleUnits) - Number(capacity?.reservedUnits || 0), 0);

  return {
    slotKey,
    dateKey,
    time,
    requiredCount,
    eligibleUnits,
    availableUnits,
    capacity,
  };
}

async function reserveSlotCapacityForBooking(booking, { session } = {}) {
  const { startAt, endAt } = buildBookingWindow(booking);
  const requiredCount = Math.max(Number((await computeRequiredPartners(booking))?.requiredCount) || 1, 1);
  const slotWindows = buildSlotWindows(startAt, endAt);

  if (!slotWindows.length) {
    const error = new Error("Selected slot is no longer available");
    error.statusCode = 409;
    throw error;
  }

  const reservedSlotKeys = [];

  for (const window of slotWindows) {
    const snapshot = await getSlotAvailabilitySnapshot(booking, window.slotStart, window.slotEnd, session);
    if (snapshot.eligibleUnits < requiredCount) {
      const error = new Error("Selected slot is no longer available");
      error.statusCode = 409;
      throw error;
    }

    const updated = await SlotCapacity.findOneAndUpdate(
      {
        slotKey: snapshot.slotKey,
        reservedUnits: { $lte: Math.max(Number(snapshot.capacity?.totalUnits || snapshot.eligibleUnits) - requiredCount, 0) },
      },
      {
        $inc: { reservedUnits: requiredCount },
        $set: {
          pincode: String(booking.pincode || "").trim(),
          dateKey: snapshot.dateKey,
          time: snapshot.time,
          totalUnits: snapshot.eligibleUnits,
          updatedAt: new Date(),
        },
      },
      { new: true, session }
    );

    if (!updated) {
      const error = new Error("Selected slot is no longer available");
      error.statusCode = 409;
      throw error;
    }

    reservedSlotKeys.push(snapshot.slotKey);
  }

  const expiresAt = new Date(Date.now() + SLOT_LOCK_MINUTES * 60 * 1000);
  const [lock] = await SlotLock.create(
    [
      {
        bookingId: booking._id,
        bookingNumber: booking.bookingNumber || "",
        pincode: String(booking.pincode || "").trim(),
        dateKey: normalizeDateKey(startAt),
        slotKeys: reservedSlotKeys,
        units: requiredCount,
        status: "PENDING_PAYMENT",
        expiresAt,
      },
    ],
    { session }
  );

  await Booking.updateOne(
    { _id: booking._id },
    {
      $set: {
        slotLockId: lock._id,
        slotReservationUnits: requiredCount,
        slotReservationExpiresAt: expiresAt,
        lockedUntil: expiresAt,
        lockedCapacityMinutes: booking.estimatedDurationMinutes || 60,
      },
    },
    { session }
  );

  return {
    lock,
    reservedSlotKeys,
    requiredCount,
    expiresAt,
  };
}

async function markSlotLockPaid(bookingId, { session } = {}) {
  return SlotLock.findOneAndUpdate(
    { bookingId, status: "PENDING_PAYMENT" },
    {
      $set: {
        status: "PAID",
        expiresAt: null,
      },
    },
    { new: true, session }
  );
}

async function releaseSlotCapacityByBookingId(bookingId, { session, releaseReason = "" } = {}) {
  const bookingMeta = await Booking.findById(bookingId)
    .select("pincode scheduledDate")
    .lean();

  let lockQuery = SlotLock.findOne({ bookingId });
  if (session) {
    lockQuery = lockQuery.session(session);
  }
  const lock = await lockQuery;
  if (!lock || lock.status === "RELEASED") {
    return { released: false, lock: lock || null };
  }

  const units = Math.max(Number(lock.units || 1), 1);
  for (const slotKey of lock.slotKeys || []) {
    await SlotCapacity.updateOne(
      { slotKey, reservedUnits: { $gte: units } },
      {
        $inc: { reservedUnits: -units },
        $set: { updatedAt: new Date() },
      },
      { session }
    );
  }

  await SlotLock.updateOne(
    { _id: lock._id, status: { $ne: "RELEASED" } },
    {
      $set: {
        status: "RELEASED",
        releasedAt: new Date(),
        releaseReason: String(releaseReason || "").trim().slice(0, 200),
      },
    },
    { session }
  );

  await Booking.updateOne(
    { _id: bookingId },
    {
      $set: {
        slotLockId: null,
        slotReservationUnits: 0,
        slotReservationExpiresAt: null,
        lockedUntil: null,
        lockedCapacityMinutes: 0,
      },
    },
    { session }
  );

  if (bookingMeta?.pincode && bookingMeta?.scheduledDate) {
    try {
      const { clearSlotCache } = getSchedulingService();
      clearSlotCache(bookingMeta.pincode, bookingMeta.scheduledDate);
    } catch (_) {
      // cache invalidation is best-effort
    }
  }

  return { released: true, lock };
}

async function cleanupExpiredSlotLocks({ limit = 100 } = {}) {
  const now = new Date();
  const expiredLocks = await SlotLock.find({
    status: "PENDING_PAYMENT",
    expiresAt: { $lte: now },
  })
    .sort({ expiresAt: 1 })
    .limit(limit)
    .lean();

  if (!expiredLocks.length) {
    return { scanned: 0, released: 0 };
  }

  let released = 0;
  for (const lock of expiredLocks) {
    const booking = await Booking.findById(lock.bookingId).select("status payment");
    if (booking && booking.status === "PENDING_PAYMENT") {
      booking.status = "CANCELLED";
      booking.cancelledBy = "system";
      booking.cancelReason = "Payment lock expired";
      await booking.save();
    }

    const result = await releaseSlotCapacityByBookingId(lock.bookingId, {
      releaseReason: "payment_lock_expired",
    });
    if (result.released) released += 1;
  }

  return { scanned: expiredLocks.length, released };
}

module.exports = {
  SLOT_LOCK_MINUTES,
  buildSlotKey,
  buildSlotWindows,
  cleanupExpiredSlotLocks,
  getSlotAvailabilitySnapshot,
  releaseSlotCapacityByBookingId,
  reserveSlotCapacityForBooking,
  markSlotLockPaid,
};
