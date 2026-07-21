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

async function getSlotAvailabilitySnapshot(
  booking,
  slotStart,
  slotEnd,
  session,
  { readOnly = false } = {}
) {
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

  // readOnly: the slot-LISTING path (which includes the unauthenticated
  // available-slots endpoint) must not write — the old unconditional upsert let
  // anonymous requests mint a SlotCapacity row per slot-window per category,
  // an unbounded collection-growth vector. A missing row simply means nothing
  // is reserved yet. The reservation path keeps the upsert.
  const capacity = readOnly
    ? await SlotCapacity.findOne({ slotKey }).lean()
    : await SlotCapacity.findOneAndUpdate(
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

/*
=====================================================
RESERVATION — PREPARE / COMMIT SPLIT

prepareSlotReservation runs every EXPENSIVE read (per-window partner
eligibility, zone/hub resolution, category resolution, SlotCapacity row
upsert) with NO transaction session. commitSlotReservation then performs only
the tiny atomic writes (guarded $inc per window + SlotLock insert + Booking
update) — the part that belongs inside createBooking's transaction.

Why: with the old single function, N simultaneous requests for the same slot
each held the transaction open across the whole eligibility stack, so every
transaction fought over the same SlotCapacity document for its entire
lifetime → WriteConflict retry storms. Keeping the transaction to a few
milliseconds shrinks the conflict window to almost nothing.

Oversell safety is unchanged: the guarded conditional $inc in commit re-checks
reservedUnits atomically at write time, so a stale prepare can only produce a
clean 409 — never an overbooked slot.
=====================================================
*/
async function prepareSlotReservation(booking) {
  const { startAt, endAt } = buildBookingWindow(booking);
  const requiredCount = Math.max(Number((await computeRequiredPartners(booking))?.requiredCount) || 1, 1);
  const slotWindows = buildSlotWindows(startAt, endAt);

  if (!slotWindows.length) {
    const error = new Error("Selected slot is no longer available");
    error.statusCode = 409;
    throw error;
  }

  const snapshots = [];
  for (const window of slotWindows) {
    // No session: the upsert + eligibility count commit immediately. This also
    // fast-fails a full slot with a 409 BEFORE the caller opens a transaction
    // or inserts a Booking row.
    const snapshot = await getSlotAvailabilitySnapshot(booking, window.slotStart, window.slotEnd, null);
    // Not enough eligible partners, OR the window's units are already reserved
    // by other bookings. The availableUnits check is advisory (commit's guarded
    // $inc is the real gate) but it turns the common contention case — many
    // customers racing one slot — into a cheap pre-transaction 409.
    if (snapshot.eligibleUnits < requiredCount || snapshot.availableUnits < requiredCount) {
      const error = new Error("Selected slot is no longer available");
      error.statusCode = 409;
      throw error;
    }
    snapshots.push(snapshot);
  }

  return { startAt, requiredCount, snapshots };
}

async function commitSlotReservation(booking, prepared, { session } = {}) {
  const { startAt, requiredCount, snapshots } = prepared;
  const reservedSlotKeys = [];

  try {
    for (const snapshot of snapshots) {
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
  } catch (err) {
    // Sessionless callers (reschedule) have no transaction to roll back a
    // partial multi-window reservation — undo any windows already incremented
    // so a mid-loop 409 can't permanently leak reserved units. Transactional
    // callers skip this: the aborting transaction reverts everything itself.
    if (!session && reservedSlotKeys.length) {
      for (const slotKey of reservedSlotKeys) {
        await SlotCapacity.updateOne(
          { slotKey, reservedUnits: { $gte: requiredCount } },
          { $inc: { reservedUnits: -requiredCount }, $set: { updatedAt: new Date() } }
        ).catch(() => {});
      }
    }
    throw err;
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

// Single-call convenience for paths without a surrounding transaction
// (rescheduleBooking). createBooking calls prepare/commit separately so the
// expensive prepare stays outside its transaction.
async function reserveSlotCapacityForBooking(booking, { session } = {}) {
  const prepared = await prepareSlotReservation(booking);
  return commitSlotReservation(booking, prepared, { session });
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

async function releaseSlotCapacityByBookingId(
  bookingId,
  { session, releaseReason = "", onlyIfPendingPayment = false } = {}
) {
  const bookingMeta = await Booking.findById(bookingId)
    .select("pincode scheduledDate")
    .lean();

  // CLAIM FIRST: atomically flip the lock to RELEASED before touching counters.
  // Two concurrent releases for the same booking could both pass a read-then-
  // write check and double-decrement reservedUnits; only one can win this claim.
  // Excluding RELEASED locks in the claim also keeps the reschedule case safe (a
  // rescheduled booking can have an old RELEASED lock plus a live one).
  //
  // onlyIfPendingPayment restricts the claim to a still-unpaid lock. The expiry
  // cron uses it so it can never release a reservation the payment path has just
  // converted to a permanent (PAID) hold — the claim simply no-ops instead.
  let claimQuery = SlotLock.findOneAndUpdate(
    {
      bookingId,
      status: onlyIfPendingPayment ? "PENDING_PAYMENT" : { $ne: "RELEASED" },
    },
    {
      $set: {
        status: "RELEASED",
        releasedAt: new Date(),
        releaseReason: String(releaseReason || "").trim().slice(0, 200),
      },
    }
  );
  if (session) {
    claimQuery = claimQuery.session(session);
  }
  // Pre-image: units/slotKeys as they were reserved.
  const lock = await claimQuery;
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
    // GUARDED cancel: only a booking still awaiting an unpaid checkout may be
    // expired. The old findById + save raced finalizePaidBooking — a payment
    // landing between the read and the save was overwritten with CANCELLED.
    // The payment guard makes the paid booking win unconditionally.
    await Booking.updateOne(
      {
        _id: lock.bookingId,
        status: "PENDING_PAYMENT",
        "payment.status": { $ne: "PAID" },
      },
      {
        $set: {
          status: "CANCELLED",
          cancelledBy: "system",
          cancelledAt: now,
          cancelReason: "Payment lock expired",
        },
      }
    );

    // onlyIfPendingPayment: if the payment finalizer marked this lock PAID while
    // we were scanning, the release no-ops and the paid booking keeps its
    // reservation instead of having its capacity handed back to the pool.
    const result = await releaseSlotCapacityByBookingId(lock.bookingId, {
      releaseReason: "payment_lock_expired",
      onlyIfPendingPayment: true,
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
  commitSlotReservation,
  getSlotAvailabilitySnapshot,
  prepareSlotReservation,
  releaseSlotCapacityByBookingId,
  reserveSlotCapacityForBooking,
  resolveCapacityScope,
  markSlotLockPaid,
};
