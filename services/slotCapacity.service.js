const Booking = require("../models/Booking");
const SlotCapacity = require("../models/SlotCapacity");
const SlotLock = require("../models/SlotLock");
const { computeRequiredPartners } = require("./assignmentEngine");

const SLOT_LOCK_MINUTES = 10;

function getSchedulingService() {
  return require("./scheduling_service");
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

async function getEligibleUnitsForWindow(booking, slotStart, slotEnd, session) {
  const { findEligiblePartnersForBooking } = getSchedulingService();

  const serviceIds = (booking.services || []).map((s) => String(s?.serviceId || "")).filter(Boolean);
  console.log(`[slotReserve] getEligibleUnits pincode=${booking.pincode} serviceCategory=${booking.serviceCategory} serviceIds=[${serviceIds.join(",")}] slotStart=${slotStart} slotEnd=${slotEnd}`);

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
    // 2nd arg is the pincode-stage filter. Pass [] (no filter) so slot-capacity
    // counting considers the whole zone — matching the previous behaviour.
    // rejectedPartners is read from the booking object above, not from here.
    [],
    { requireOnline: false, session }
  );

  console.log(`[slotReserve] getEligibleUnits → ${candidates.length} candidates`);
  return candidates.length;
}

async function getSlotAvailabilitySnapshot(booking, slotStart, slotEnd, session) {
  const requiredCount = Math.max(Number((await computeRequiredPartners(booking))?.requiredCount) || 1, 1);
  const eligibleUnits = await getEligibleUnitsForWindow(booking, slotStart, slotEnd, session);
  const dateKey = normalizeDateKey(slotStart);
  const time = getTimeLabel(slotStart);
  const slotKey = buildSlotKey(booking.pincode, dateKey, time);

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

  console.log(`[slotReserve] booking=${booking._id} pincode=${booking.pincode} date=${booking.scheduledDate} time=${booking.scheduledTime} startAt=${startAt} endAt=${endAt} requiredCount=${requiredCount} slotWindows=${slotWindows.length}`);

  if (!slotWindows.length) {
    console.error(`[slotReserve] FAIL: slotWindows is empty — startAt=${startAt} endAt=${endAt}`);
    const error = new Error("Selected slot is no longer available");
    error.statusCode = 409;
    throw error;
  }

  const reservedSlotKeys = [];

  for (const window of slotWindows) {
    const snapshot = await getSlotAvailabilitySnapshot(booking, window.slotStart, window.slotEnd, session);
    console.log(`[slotReserve] window ${window.time}: eligibleUnits=${snapshot.eligibleUnits} requiredCount=${requiredCount} reservedUnits=${snapshot.capacity?.reservedUnits} totalUnits=${snapshot.capacity?.totalUnits}`);
    if (snapshot.eligibleUnits < requiredCount) {
      console.error(`[slotReserve] FAIL: eligibleUnits(${snapshot.eligibleUnits}) < requiredCount(${requiredCount}) for slot ${window.time}`);
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
