const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const SlotCapacity = require("../models/SlotCapacity");
const SlotLock = require("../models/SlotLock");
const { computeRequiredPartners, getUseH3Flag } = require("./assignmentEngine");
const {
  resolveZoneForPincode,
  getZoneCoveragePincodes,
  resolveHubForH3Cell,
  resolveHubsForCells,
} = require("./zone.service");
const { getH3Ring } = require("../utils/h3");

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

Hub (H3) mode: partners are shared across the hub's cells instead, so capacity
is keyed per HUB and eligibility is counted via the hub path. The pincode's
Zone may even be disabled in hub mode — it must not gate capacity here.

Returns a stable scope key (so every pincode/cell the territory covers shares
one counter), the zone's coverage pincodes (pincode path), and the cell's
ring-1 hubCells (hub path; ring-1 absorbs pincode-centroid fuzz, same as the
slot engine's hub gate). Unzoned pincodes — which cannot take bookings anyway —
fall back to per-pincode scope, preserving the previous behaviour.
=====================================================
*/
async function resolveCapacityScope(
  pincode,
  { hubMode = false, h3Cell = null, categoryIds = null } = {}
) {
  const raw = String(pincode || "").trim();

  if (hubMode && h3Cell) {
    const hubCells = getH3Ring(h3Cell, 1);
    const catIds = Array.isArray(categoryIds) && categoryIds.length ? categoryIds : null;

    // The scope key must be the hub serving THIS booking's category. Hubs of
    // different categories may overlap the same cells, so a category-blind
    // findOne can key two bookings of the same AC hub to two different scope
    // keys — each then reserves the full shared pool independently (the exact
    // oversubscription hub-keying exists to prevent).
    let homeHub = null;
    for (const catId of catIds || [null]) {
      homeHub = await resolveHubForH3Cell(h3Cell, { categoryId: catId });
      if (homeHub) break;
    }

    // Partner pool for the eligibility count: partner-enabled hubs of the same
    // categories within ring-1 — the same set the per-slot search uses.
    const hubIds = await resolveHubsForCells(hubCells, {
      categoryIds: catIds,
      requirePartnerApp: true,
    });

    const hubId = homeHub ? String(homeHub._id) : String(hubIds[0] || "");
    if (hubId) {
      return { scopeKey: `hub:${hubId}`, coveragePincodes: raw ? [raw] : [], hubCells, hubIds };
    }
    // No hub covers this cell — fall through to the zone/pincode scope.
  }

  const zone = await resolveZoneForPincode(raw);
  if (!zone) {
    return { scopeKey: raw, coveragePincodes: raw ? [raw] : [], hubCells: null, hubIds: null };
  }
  const coveragePincodes = getZoneCoveragePincodes(zone);
  return {
    scopeKey: `zone:${String(zone._id)}`,
    coveragePincodes: coveragePincodes.length ? coveragePincodes : raw ? [raw] : [],
    hubCells: null,
    hubIds: null,
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

function buildSlotKey(pincode, dateKey, time, categoryKey = "") {
  const cat = String(categoryKey || "").trim() || "general";
  return `${String(pincode || "").trim()}:${cat}:${dateKey}:${time}`;
}

/*
=====================================================
CATEGORY KEY
Capacity must be counted PER SERVICE-CATEGORY POOL, not just per territory.
The old key (scope:date:time) made every category in a zone share one counter
while totalUnits was overwritten with the *current* request's category-specific
eligible count — e.g. 3 mehendi reservations at 14:00 could zero out AC
availability for the whole zone (totalUnits=2 AC techs − 3 reserved = 0).

The key is derived from the DB Service records (never client input) so the
slot-listing path and the createBooking reservation path always agree.
=====================================================
*/
function normalizeCategorySlug(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function resolveCategoryKeyForBooking(booking) {
  const ids = [
    ...(Array.isArray(booking?.services)
      ? booking.services.map((s) => s?.serviceId)
      : []),
    booking?.serviceId,
  ]
    .map((v) => String(v || "").trim())
    .filter((v) => mongoose.Types.ObjectId.isValid(v));

  const slugs = new Set();
  if (ids.length) {
    const Service = require("../models/service.model");
    const rows = await Service.find({ _id: { $in: [...new Set(ids)] } })
      .select("category legacyCategory")
      .populate("category", "slug name")
      .lean();
    for (const row of rows) {
      const slug = normalizeCategorySlug(
        row?.category?.slug || row?.category?.name || row?.legacyCategory || ""
      );
      if (slug) slugs.add(slug);
    }
  }

  // No resolvable service ids (very old legacy payloads) — fall back to the
  // request's category string, then to the shared "general" pool.
  if (!slugs.size) {
    const fallback = normalizeCategorySlug(booking?.serviceCategory);
    if (fallback) slugs.add(fallback);
  }
  if (!slugs.size) return "general";

  return [...slugs].sort().join("+");
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

async function getEligibleUnitsForWindow(booking, slotStart, slotEnd, scope, session) {
  const { findEligiblePartnersForBooking } = getSchedulingService();
  const hubMode = Boolean(scope?.hubCells && scope.hubCells.length);

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
      h3Cell: booking.h3Cell || null,
      rejectedPartners: booking.rejectedPartners || [],
    },
    // 2nd arg is the territory filter. Hub path: the cell's ring-1 cells (the
    // assignment engine's stage-2 reach). Pincode path: the zone's coverage
    // pincodes (the widest assignment stage). Either way the count reflects
    // partners who actually serve THIS area — not every partner in the system.
    // rejectedPartners is read from the booking object above, not from here.
    hubMode ? scope.hubCells : scope?.coveragePincodes || [],
    // Hub path reuses the category-scoped, partner-enabled hub set already
    // resolved by resolveCapacityScope (precomputedHubIds).
    {
      requireOnline: false,
      useH3: hubMode,
      precomputedHubIds: hubMode ? scope.hubIds : null,
      session,
    }
  );

  return candidates.length;
}

async function getSlotAvailabilitySnapshot(booking, slotStart, slotEnd, session) {
  const requiredCount = Math.max(Number((await computeRequiredPartners(booking))?.requiredCount) || 1, 1);
  // Hub path is active only when the flag is on AND this booking has a derived
  // h3Cell — mirrors the assignment engine. Bookings without a cell (legacy,
  // or created before the flag flipped) keep the pincode/zone scope.
  const hubMode = (await getUseH3Flag()) && Boolean(booking.h3Cell);
  // Hub scope is per-category (hubs of different services overlap) — resolve
  // the booking's categories so the scope key lands on the right hub.
  let scopeCategoryIds = null;
  if (hubMode) {
    const { resolveBookingCategories } = require("./zone.service");
    scopeCategoryIds = (await resolveBookingCategories(booking)).map((c) => c.id);
  }
  const scope = await resolveCapacityScope(booking.pincode, {
    hubMode,
    h3Cell: booking.h3Cell || null,
    categoryIds: scopeCategoryIds,
  });
  const { scopeKey } = scope;
  const eligibleUnits = await getEligibleUnitsForWindow(booking, slotStart, slotEnd, scope, session);
  const dateKey = normalizeDateKey(slotStart);
  const time = getTimeLabel(slotStart);
  // Key capacity by zone (hub in H3 mode), not raw pincode, so every pincode
  // the territory covers shares ONE counter — otherwise each pincode reserves
  // the full shared pool independently and the slot is oversold. The category
  // key keeps disjoint partner pools (AC vs mehendi) on separate counters.
  const categoryKey = await resolveCategoryKeyForBooking(booking);
  const slotKey = buildSlotKey(scopeKey, dateKey, time, categoryKey);

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

  // Exclude RELEASED locks in the query itself: a rescheduled booking can have
  // an old RELEASED lock plus a live one, and findOne with no filter could
  // grab the released row and wrongly no-op, stranding the live reservation.
  let lockQuery = SlotLock.findOne({ bookingId, status: { $ne: "RELEASED" } });
  if (session) {
    lockQuery = lockQuery.session(session);
  }
  const lock = await lockQuery;
  if (!lock) {
    return { released: false, lock: null };
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
  resolveCapacityScope,
  markSlotLockPaid,
};
