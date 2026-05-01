const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");
const AdminSetting = require("../admin/models/AdminSetting");

/*
=====================================================
CONSTANTS
=====================================================
*/
const WORKDAY_START_HOUR = 9;
const WORKDAY_END_HOUR = 20;
const SLOT_GAP_MINUTES = 60;
const DEFAULT_SERVICE_DURATION_MINUTES = 60;
const DEFAULT_TRAVEL_BUFFER_MINUTES = 30;

// AC bookings: 45-minute travel/prep buffer (equipment carry overhead)
const AC_TRAVEL_BUFFER_MINUTES = 45;

// AC bookings: 360 min max per technician (physically heavier, more variable)
const AC_MAX_CAPACITY_MINUTES = 360;

// General / Mehendi: 420 min max (7 hours)
const GENERAL_MAX_CAPACITY_MINUTES = 420;

const MAX_RADIUS_METERS = 8 * 1000;
const FAIRNESS_LOOKBACK_HOURS = 12;

// AC category detection slugs — extend this list as needed
const AC_CATEGORY_SLUGS = ["ac", "air conditioner", "air-conditioner", "aircon"];

const BLOCKING_BOOKING_STATUSES = [
  "ASSIGNED",
  "PARTNER_ACCEPTED",
  "ON_THE_WAY",
  "IN_PROGRESS",
];

/*
=====================================================
HELPERS
=====================================================
*/
function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeDateKey(dateInput) {
  const date = new Date(dateInput);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getDate()).padStart(2, "0")}`;
}

function buildDateTime(dateInput, time = "00:00") {
  const date = new Date(dateInput);
  const [hours, minutes] = String(time || "00:00")
    .split(":")
    .map((part) => Number(part) || 0);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    hours,
    minutes,
    0,
    0
  );
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function getDayBounds(dateInput) {
  const date = new Date(dateInput);
  const start = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0
  );
  const end = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1,
    0,
    0,
    0,
    0
  );
  return { start, end };
}

function getTimeLabel(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

function uniqueStrings(values = []) {
  return [
    ...new Set(
      values.map((value) => String(value || "").trim()).filter(Boolean)
    ),
  ];
}

function toObjectIdString(value) {
  return value ? String(value).trim() : "";
}

/*
=====================================================
DETECT AC CATEGORY
=====================================================
*/
function isACCategory(categorySlug = "") {
  const normalized = normalizeText(categorySlug);
  return AC_CATEGORY_SLUGS.some((slug) => normalized.includes(slug));
}

/*
=====================================================
SERVICE MAP LOADER
=====================================================
*/
async function loadServiceMap(serviceIds = []) {
  const ids = uniqueStrings(serviceIds);
  if (!ids.length) return new Map();

  const services = await Service.find({ _id: { $in: ids } })
    .select("_id duration category subCategory legacyCategory name isActive skillTier")
    .populate("category", "slug name")
    .populate("subCategory", "name")
    .lean();

  return new Map(services.map((s) => [String(s._id), s]));
}

/*
=====================================================
REQUEST CONTEXT BUILDER
=====================================================
*/
async function buildRequestContext({
  booking = null,
  serviceId = null,
  serviceCategory = null,
  services = [],
} = {}) {
  const requestServices =
    Array.isArray(services) && services.length
      ? services
      : Array.isArray(booking?.services) && booking.services.length
      ? booking.services
      : serviceId
      ? [{ serviceId }]
      : booking?.serviceId
      ? [{ serviceId: booking.serviceId }]
      : [];

  const requestedServiceIds = uniqueStrings(
    requestServices.map((item) => item?.serviceId)
  );
  const serviceMap = await loadServiceMap(requestedServiceIds);

  const requestedCategories = uniqueStrings([
    serviceCategory,
    booking?.serviceCategory,
    ...requestServices.map((item) => item?.category),
    ...Array.from(serviceMap.values()).map(
      (service) =>
        service?.category?.slug ||
        service?.category?.name ||
        service?.legacyCategory ||
        ""
    ),
  ]).map(normalizeText);

  const requestedSubCategories = uniqueStrings([
    ...requestServices.map((item) => item?.subCategory),
    ...Array.from(serviceMap.values()).map(
      (service) => service?.subCategory?.name || ""
    ),
  ]).map(normalizeText);

  // Determine if this is an AC booking for downstream routing
  const isAC =
    requestedCategories.some(isACCategory) ||
    isACCategory(booking?.serviceCategory || "");

  // For AC: derive the maximum required skill tier from the cart
  // Level 1 = general cleaning/filter wash
  // Level 2 = gas top-up, diagnosis
  // Level 3 = PCB repair, installation
  let requiredSkillTier = null;
  if (isAC) {
    const serviceTiers = Array.from(serviceMap.values())
      .map((s) => Number(s.skillTier || 1))
      .filter(Number.isFinite);
    requiredSkillTier = serviceTiers.length
      ? Math.max(...serviceTiers)
      : 1;
  }

  return {
    requestServices,
    requestedServiceIds,
    requestedCategories,
    requestedSubCategories,
    serviceMap,
    isAC,
    requiredSkillTier,
  };
}

/*
=====================================================
DURATION CALCULATOR
AC bookings bypass the 240-min cap (multi-unit
installs can run 300–360 min).
=====================================================
*/
function calculateDurationMinutesFromRequest(
  requestServices,
  serviceMap,
  isAC = false
) {
  if (!requestServices?.length) {
    return DEFAULT_SERVICE_DURATION_MINUTES;
  }

  const total = requestServices.reduce((sum, item) => {
    const service = serviceMap.get(toObjectIdString(item?.serviceId));
    const duration = Math.max(
      Number(service?.duration) || DEFAULT_SERVICE_DURATION_MINUTES,
      1
    );
    const quantity = Math.max(Number(item?.quantity || 1), 1);
    return sum + duration * quantity;
  }, 0);

  const maxDuration = isAC ? AC_MAX_CAPACITY_MINUTES : 240;
  return Math.min(Math.max(total, DEFAULT_SERVICE_DURATION_MINUTES), maxDuration);
}

/*
=====================================================
BOOKING WINDOW RESOLVER
=====================================================
*/
async function getBookingWindow(booking) {
  const requestContext = await buildRequestContext({ booking });
  const travelBuffer = requestContext.isAC
    ? AC_TRAVEL_BUFFER_MINUTES
    : DEFAULT_TRAVEL_BUFFER_MINUTES;

  const scheduledStartAt = booking?.scheduledStartAt
    ? new Date(booking.scheduledStartAt)
    : buildDateTime(booking.scheduledDate, booking.scheduledTime);

  const rawDurationMinutes =
    Math.max(Number(booking?.estimatedDurationMinutes) || 0, 0) ||
    calculateDurationMinutesFromRequest(
      requestContext.requestServices,
      requestContext.serviceMap,
      requestContext.isAC
    );

  // For slot-availability purposes, include travel buffer in end time
  // so back-to-back bookings leave the partner enough transit time.
  const durationMinutes = rawDurationMinutes;
  const scheduledEndAt = booking?.scheduledEndAt
    ? new Date(booking.scheduledEndAt)
    : addMinutes(scheduledStartAt, durationMinutes + travelBuffer);

  return {
    scheduledStartAt,
    scheduledEndAt,
    durationMinutes,
    travelBuffer,
    requestContext,
  };
}

/*
=====================================================
WORKDAY GUARD
=====================================================
*/
function isInsideWorkday(startAt, endAt) {
  const workdayStart = new Date(
    startAt.getFullYear(),
    startAt.getMonth(),
    startAt.getDate(),
    WORKDAY_START_HOUR,
    0,
    0,
    0
  );
  const workdayEnd = new Date(
    startAt.getFullYear(),
    startAt.getMonth(),
    startAt.getDate(),
    WORKDAY_END_HOUR,
    0,
    0,
    0
  );
  return startAt >= workdayStart && endAt <= workdayEnd;
}

/*
=====================================================
PARTNER SYNC
Recomputes activeJobs based on bookings whose
window currently overlaps "now" — future bookings
don't inflate the live active count.
=====================================================
*/
async function syncPartnerOperationalState(partnerId) {
  const id = toObjectIdString(partnerId);
  if (!id) return null;

  const partner = await Partner.findById(id);
  if (!partner) return null;

  const blockingBookings = await Booking.find({
    partner: partner._id,
    status: { $in: BLOCKING_BOOKING_STATUSES },
  })
    .select("scheduledDate scheduledTime estimatedDurationMinutes serviceCategory")
    .sort({ scheduledDate: 1, scheduledTime: 1 })
    .lean();

  const now = new Date();
  const bookingWindows = await Promise.all(
    blockingBookings.map(async (b) => {
      const window = await getBookingWindow(b);
      return { startAt: window.scheduledStartAt, endAt: window.scheduledEndAt };
    })
  );

  partner.activeJobs = bookingWindows.filter(
    (w) => now >= w.startAt && now < w.endAt
  ).length;
  partner.busySlots = blockingBookings.map((b) => ({
    date: b.scheduledDate,
    time: b.scheduledTime,
  }));

  await partner.save();
  return partner;
}

/*
=====================================================
AVAILABILITY WINDOW CHECKS
=====================================================
*/
function windowsOverlap(cStart, cEnd, eStart, eEnd) {
  return cStart < eEnd && cEnd > eStart;
}

function isWindowAvailable(candidateWindow, existingWindows = []) {
  // The candidate window already includes travel buffer from getBookingWindow()
  // so we apply it directly without doubling.
  return !existingWindows.some((w) =>
    windowsOverlap(
      candidateWindow.startAt,
      candidateWindow.endAt,
      w.startAt,
      w.endAt
    )
  );
}

function calculateAvailabilitySlackMinutes(candidateWindow, existingWindows = []) {
  if (!existingWindows.length) return Number.POSITIVE_INFINITY;
  const futureWindows = existingWindows
    .filter((w) => w.startAt >= candidateWindow.endAt)
    .sort((a, b) => a.startAt - b.startAt);
  if (!futureWindows.length) return Number.POSITIVE_INFINITY;
  return Math.max(
    Math.round(
      (futureWindows[0].startAt - candidateWindow.endAt) / (1000 * 60)
    ),
    0
  );
}

/*
=====================================================
BLOCKING WINDOWS BY PARTNER
=====================================================
*/
async function getBlockingWindowsByPartner(partnerIds = [], dateInput) {
  const ids = uniqueStrings(partnerIds);
  if (!ids.length) return new Map();

  const { start, end } = getDayBounds(dateInput);
  const bookings = await Booking.find({
    $or: [{ partner: { $in: ids } }, { additionalPartners: { $in: ids } }],
    status: { $in: BLOCKING_BOOKING_STATUSES },
    scheduledDate: { $gte: start, $lt: end },
  })
    .select(
      "_id partner additionalPartners services serviceId scheduledDate scheduledTime estimatedDurationMinutes scheduledStartAt scheduledEndAt serviceCategory"
    )
    .lean();

  const allServiceIds = uniqueStrings(
    bookings.flatMap((b) => [
      b?.serviceId,
      ...(b?.services || []).map((item) => item?.serviceId),
    ])
  );
  const serviceMap = await loadServiceMap(allServiceIds);

  const windowsByPartner = new Map(ids.map((id) => [id, []]));

  for (const booking of bookings) {
    const partnerIdsInBooking = [
      booking.partner,
      ...(booking.additionalPartners || []),
    ]
      .map(toObjectIdString)
      .filter(Boolean);

    const requestServices =
      Array.isArray(booking.services) && booking.services.length
        ? booking.services
        : booking.serviceId
        ? [{ serviceId: booking.serviceId }]
        : [];

    const bookingIsAC = isACCategory(booking.serviceCategory || "");
    const durationMinutes =
      Math.max(Number(booking.estimatedDurationMinutes) || 0, 0) ||
      calculateDurationMinutesFromRequest(requestServices, serviceMap, bookingIsAC);

    const travelBuffer = bookingIsAC
      ? AC_TRAVEL_BUFFER_MINUTES
      : DEFAULT_TRAVEL_BUFFER_MINUTES;

    const startAt = booking.scheduledStartAt
      ? new Date(booking.scheduledStartAt)
      : buildDateTime(booking.scheduledDate, booking.scheduledTime);

    // End includes the travel buffer to block transit time
    const endAt = booking.scheduledEndAt
      ? new Date(booking.scheduledEndAt)
      : addMinutes(startAt, durationMinutes + travelBuffer);

    for (const partnerId of partnerIdsInBooking) {
      if (windowsByPartner.has(partnerId)) {
        windowsByPartner.get(partnerId).push({
          bookingId: String(booking._id),
          startAt,
          endAt,
        });
      }
    }
  }

  return windowsByPartner;
}

/*
=====================================================
SKILL MATCH
=====================================================
*/
function collectPartnerServiceIds(partner) {
  return new Set(
    (partner?.services || [])
      .filter((item) => item?.isActive !== false)
      .map((item) => toObjectIdString(item?.serviceId))
      .filter(Boolean)
  );
}

function collectPartnerCategories(partner) {
  return new Set(
    uniqueStrings([
      ...(partner?.serviceCategories || []),
      ...(partner?.services || []).map((item) => item?.category),
    ]).map(normalizeText)
  );
}

function collectPartnerSubCategories(partner) {
  return new Set(
    uniqueStrings(
      (partner?.services || []).map((item) => item?.subCategory)
    ).map(normalizeText)
  );
}

function getPartnerSkillMatchLevel(partner, requestContext) {
  const {
    requestedServiceIds,
    requestedSubCategories,
    requestedCategories,
    isAC,
    requiredSkillTier,
  } = requestContext;

  // AC SKILL GATE: if the booking requires a Level 2/3 technician, block
  // servicemen (skillTier: 1) from being matched entirely. This prevents
  // servicemen from accepting gas or PCB jobs they cannot complete.
  if (isAC && requiredSkillTier >= 2) {
    const partnerTier = Number(partner.skillTier || 1);
    if (partnerTier < requiredSkillTier) return 0;
  }

  const partnerServiceIds = collectPartnerServiceIds(partner);
  const partnerSubCategories = collectPartnerSubCategories(partner);
  const partnerCategories = collectPartnerCategories(partner);

  // Smart onboarded partners (strict check)
  if (partnerServiceIds.size > 0) {
    if (!requestedServiceIds.length) return 1;
    const matchingCount = requestedServiceIds.filter((id) =>
      partnerServiceIds.has(id)
    ).length;
    if (matchingCount === requestedServiceIds.length) return 3;
    if (matchingCount > 0) return 2.5;
    return 0; // Defined skills but no match — hard block
  }

  // Legacy partners (broad category fallback)
  if (
    requestedSubCategories.length &&
    requestedSubCategories.every((sc) => partnerSubCategories.has(sc))
  ) {
    return 2;
  }

  if (
    requestedCategories.length &&
    requestedCategories.every((c) => partnerCategories.has(c))
  ) {
    return 1;
  }

  return 0;
}

/*
=====================================================
DISTANCE CALCULATOR (Haversine)
=====================================================
*/
function calculateDistanceMeters(origin, destination) {
  if (
    !Array.isArray(origin?.coordinates) ||
    !Array.isArray(destination?.coordinates) ||
    origin.coordinates.length < 2 ||
    destination.coordinates.length < 2
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const [lng1, lat1] = origin.coordinates.map(Number);
  const [lng2, lat2] = destination.coordinates.map(Number);

  if (![lng1, lat1, lng2, lat2].every(Number.isFinite)) {
    return Number.POSITIVE_INFINITY;
  }

  const toRadians = (v) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/*
=====================================================
SCORING FUNCTIONS
=====================================================
*/
function scoreDistance(distanceMeters) {
  if (!Number.isFinite(distanceMeters)) return 0;
  return Math.max(0, 100 - Math.min(distanceMeters / 100, 100));
}

function scoreWorkload(partner) {
  const activeJobs = Number(partner?.activeJobs || 0);
  const maxJobs = Math.max(Number(partner?.maxJobsLimit || 1), 1);
  const utilization = Math.min(activeJobs / maxJobs, 1);
  return Math.max(0, 100 - utilization * 100);
}

function scoreFairness(partner) {
  if (!partner?.lastAssignedAt) return 100;
  const hoursSinceAssigned =
    (Date.now() - new Date(partner.lastAssignedAt).getTime()) /
    (1000 * 60 * 60);
  return Math.max(
    0,
    Math.min((hoursSinceAssigned / FAIRNESS_LOOKBACK_HOURS) * 100, 100)
  );
}

function scoreReliability(partner) {
  const ratingScore = Math.max(
    0,
    Math.min((Number(partner?.rating || 0) / 5) * 100, 100)
  );
  const cancellationPenalty = Math.min(
    Number(partner?.weeklyCancelCount || 0) * 20,
    60
  );
  return Math.max(0, ratingScore - cancellationPenalty);
}

function scoreSkillMatch(skillMatchLevel) {
  if (skillMatchLevel >= 3) return 100;
  if (skillMatchLevel >= 2.5) return 85;
  if (skillMatchLevel === 2) return 75;
  if (skillMatchLevel === 1) return 50;
  return 0;
}

/*
=====================================================
PARTNER SCORE
Weights differ for AC vs general/mehendi:
  AC:      skill 0.30 | fairness 0.35 | distance 0.10 | earnings 0.25
  General: skill 0.10 | fairness 0.40 | distance 0.20 | earnings 0.30

Rationale: For AC, correct skill level matters more than proximity.
A Level 3 technician 12 km away is more valuable than a Level 1 partner
2 km away for a gas-charging job. Wrong-skill assignment wastes 45+ min.
=====================================================
*/
function calculatePartnerScore({
  skillMatchLevel,
  distanceMeters,
  partner,
  earningsToday = 1,
  isAC = false,
}) {
  const idleTimeHours = partner.lastAssignedAt
    ? (Date.now() - new Date(partner.lastAssignedAt).getTime()) /
      (1000 * 60 * 60)
    : 24;
  const idleScore = Math.min(idleTimeHours / FAIRNESS_LOOKBACK_HOURS, 1) * 100;

  const distanceScore =
    distanceMeters > 0 ? Math.min((1000 / distanceMeters) * 100, 100) : 100;
  const earningsScore =
    earningsToday > 0 ? Math.min((1000 / earningsToday) * 100, 100) : 100;
  const skillScore = scoreSkillMatch(skillMatchLevel);

  // Weights vary by category
  const weights = isAC
    ? { idle: 0.35, earnings: 0.25, distance: 0.10, skill: 0.30 }
    : { idle: 0.40, earnings: 0.30, distance: 0.20, skill: 0.10 };

  const score =
    idleScore * weights.idle +
    earningsScore * weights.earnings +
    distanceScore * weights.distance +
    skillScore * weights.skill;

  return {
    score: Math.round(score * 100) / 100,
    fairnessScore: Math.round(idleScore * 100) / 100,
    distanceScore: Math.round(distanceScore * 100) / 100,
    skillScore: Math.round(skillScore * 100) / 100,
    earningsScore: Math.round(earningsScore * 100) / 100,
  };
}

/*
=====================================================
PARTNER SORT
=====================================================
*/
function sortRankedPartners(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.skillMatchLevel !== b.skillMatchLevel)
    return b.skillMatchLevel - a.skillMatchLevel;
  if (a.distanceMeters !== b.distanceMeters)
    return a.distanceMeters - b.distanceMeters;
  return String(a.partner?._id || "").localeCompare(
    String(b.partner?._id || "")
  );
}

/*
=====================================================
REACHABILITY CHECK
3-tier distance gate: ensures displayed partners
can actually arrive in time.
=====================================================
*/
function isPartnerReachable(distanceMeters, scheduledStartAt) {
  const distanceKm = distanceMeters / 1000;
  const travelTimeMinutes = distanceKm * 3; // ~3 min/km — conservative for Indian traffic
  const estimatedArrival = addMinutes(new Date(), travelTimeMinutes);

  if (distanceKm <= 5) return true; // Primary radius — always reachable
  if (distanceKm <= 15 && estimatedArrival <= scheduledStartAt) return true; // Extended + enough lead time
  if (
    distanceKm <= 25 &&
    scheduledStartAt > addMinutes(new Date(), 120)
  )
    return true; // Max radius + future booking (>2 hr away)
  return false;
}

/*
=====================================================
ELIGIBLE PARTNER FINDER
=====================================================
*/
async function findEligiblePartnersForBooking(booking, pincodes = []) {
  const requestContext = await buildRequestContext({ booking });
  if (
    !requestContext.requestedServiceIds.length &&
    !requestContext.requestedCategories.length
  ) {
    return [];
  }

  const settings = await AdminSetting.findOne().lean();

  const query = {
    isBlocked: false,
    approvalStatus: "APPROVED",
    isOnline: true,
    isAvailable: true,
    _id: { $nin: booking?.rejectedPartners || [] },
  };

  if (settings?.partnerVerificationRequired) {
    query.verificationStatus = "VERIFIED";
  }

  // For AC Level 2/3 jobs, pre-filter at DB level for technician tier
  if (requestContext.isAC && requestContext.requiredSkillTier >= 2) {
    query.skillTier = { $gte: requestContext.requiredSkillTier };
  }

  if (Array.isArray(pincodes) && pincodes.length) {
    query.$or = [
      { serviceAreas: { $in: pincodes } },
      { currentPincode: { $in: pincodes } },
      { serviceAreas: { $exists: false } },
      { serviceAreas: { $size: 0 } },
    ];
  }

  if (
    Array.isArray(booking?.location?.coordinates) &&
    booking.location.coordinates.length === 2
  ) {
    query.location = {
      $near: {
        $geometry: booking.location,
        $maxDistance: MAX_RADIUS_METERS,
      },
    };
  }

  const partners = await Partner.find(query);
  if (!partners.length) return [];

  const bookingWindow = await getBookingWindow(booking);
  if (
    !isInsideWorkday(
      bookingWindow.scheduledStartAt,
      bookingWindow.scheduledEndAt
    )
  ) {
    return [];
  }

  const windowsByPartner = await getBlockingWindowsByPartner(
    partners.map((p) => p._id),
    booking.scheduledDate
  );

  const ranked = partners
    .map((partner) => {
      const skillMatchLevel = getPartnerSkillMatchLevel(
        partner,
        requestContext
      );
      if (!skillMatchLevel) return null;

      const partnerWindows =
        windowsByPartner.get(String(partner._id)) || [];
      const candidateWindow = {
        startAt: bookingWindow.scheduledStartAt,
        endAt: bookingWindow.scheduledEndAt,
      };

      if (!isWindowAvailable(candidateWindow, partnerWindows)) return null;

      const distanceMeters = calculateDistanceMeters(
        booking.location,
        partner.location
      );
      if (
        !isPartnerReachable(
          distanceMeters,
          bookingWindow.scheduledStartAt
        )
      ) {
        return null;
      }

      // Use real completed-jobs-today earnings if available; fall back to estimate
      const earningsToday =
        partner.earningsToday > 0
          ? partner.earningsToday
          : Math.max((partner.activeJobs || 0) * 500, 1);

      const scoreBreakdown = calculatePartnerScore({
        skillMatchLevel,
        distanceMeters,
        partner,
        earningsToday,
        isAC: requestContext.isAC,
      });

      return {
        partner,
        score: scoreBreakdown.score,
        skillMatchLevel,
        distanceMeters,
        availabilitySlackMinutes: calculateAvailabilitySlackMinutes(
          candidateWindow,
          partnerWindows
        ),
        activeJobs: Number(partner.activeJobs || 0),
        lastAssignedAt: partner.lastAssignedAt,
        fairnessScore: scoreBreakdown.fairnessScore,
        earningsScore: scoreBreakdown.earningsScore,
        distanceScore: scoreBreakdown.distanceScore,
        skillScore: scoreBreakdown.skillScore,
      };
    })
    .filter(Boolean)
    .sort(sortRankedPartners);

  return ranked;
}

/*
=====================================================
SLOT AVAILABILITY ENGINE
=====================================================
*/
async function getAvailableSlotsForRequest({
  date,
  serviceId = null,
  serviceCategory = null,
  services = [],
  pincode = "",
  location = null,
} = {}) {
  if (!date) throw new Error("date is required");

  const requestContext = await buildRequestContext({
    serviceId,
    serviceCategory,
    services,
  });

  const durationMinutes = calculateDurationMinutesFromRequest(
    requestContext.requestServices,
    requestContext.serviceMap,
    requestContext.isAC
  );

  const now = new Date();
  const isToday = normalizeDateKey(date) === normalizeDateKey(now);

  // AC bookings use a tighter capacity buffer (0.70 vs 0.80) because
  // AC jobs have higher task variability — gas top-ups often run over.
  const CAPACITY_BUFFER = requestContext.isAC ? 0.70 : 0.80;
  const MAX_CAPACITY = requestContext.isAC
    ? AC_MAX_CAPACITY_MINUTES
    : GENERAL_MAX_CAPACITY_MINUTES;

  const activePartnersInZone = await Partner.countDocuments({
    $or: [{ serviceAreas: pincode }, { currentPincode: pincode }],
    isAvailable: true,
    isOnline: true,
    // For AC Level 2/3, only count technicians towards capacity
    ...(requestContext.isAC && requestContext.requiredSkillTier >= 2
      ? { skillTier: { $gte: requestContext.requiredSkillTier } }
      : {}),
  });

  const totalCapacity = activePartnersInZone * MAX_CAPACITY * CAPACITY_BUFFER;

  const existingBookings = await Booking.find({
    pincode,
    scheduledDate: date,
    $or: [
      {
        status: {
          $in: [
            "PENDING_ASSIGNMENT",
            "QUEUED",
            "ASSIGNED",
            "CONFIRMED",
            "PARTNER_ACCEPTED",
            "ON_THE_WAY",
            "IN_PROGRESS",
          ],
        },
      },
      { status: "PENDING_PAYMENT", lockedUntil: { $gt: new Date() } },
    ],
  });

  const usedCapacity = existingBookings.reduce(
    (sum, b) =>
      sum + (b.lockedCapacityMinutes || b.estimatedDurationMinutes || 60),
    0
  );

  const remainingCapacity = totalCapacity - usedCapacity;

  const slotResults = [];
  const dayStart = buildDateTime(
    date,
    `${String(WORKDAY_START_HOUR).padStart(2, "0")}:00`
  );
  const dayEnd = buildDateTime(
    date,
    `${String(WORKDAY_END_HOUR).padStart(2, "0")}:00`
  );

  for (
    let cursor = new Date(dayStart);
    cursor < dayEnd;
    cursor = addMinutes(cursor, SLOT_GAP_MINUTES)
  ) {
    const slotStart = new Date(cursor);
    const slotEnd = addMinutes(slotStart, durationMinutes);

    if (isToday && slotStart.getTime() <= now.getTime()) continue;
    if (!isInsideWorkday(slotStart, slotEnd)) continue;
    if (remainingCapacity < durationMinutes) continue; // Zone is at capacity

    const rankedPartners = await findEligiblePartnersForBooking(
      {
        scheduledDate: date,
        scheduledTime: getTimeLabel(slotStart),
        pincode,
        location,
        rejectedPartners: [],
        services: requestContext.requestServices.map((item) => ({
          serviceId: item.serviceId,
          quantity: item.quantity || 1,
          category: item.category,
          subCategory: item.subCategory,
        })),
        serviceCategory,
        estimatedDurationMinutes: durationMinutes,
        scheduledStartAt: slotStart,
        scheduledEndAt: slotEnd,
      },
      pincode ? [pincode] : []
    );

    if (!rankedPartners.length) continue;

    slotResults.push({
      time: getTimeLabel(slotStart),
      durationMinutes,
      availablePartners: rankedPartners.length,
      bestPartnerDistanceMeters: Number.isFinite(
        rankedPartners[0].distanceMeters
      )
        ? Math.round(rankedPartners[0].distanceMeters)
        : null,
      isAC: requestContext.isAC,
    });
  }

  return slotResults;
}

module.exports = {
  // Constants (exported for use in assignmentEngine.js)
  AC_CATEGORY_SLUGS,
  AC_MAX_CAPACITY_MINUTES,
  AC_TRAVEL_BUFFER_MINUTES,
  BLOCKING_BOOKING_STATUSES,
  DEFAULT_SERVICE_DURATION_MINUTES,
  DEFAULT_TRAVEL_BUFFER_MINUTES,
  SLOT_GAP_MINUTES,
  WORKDAY_END_HOUR,
  WORKDAY_START_HOUR,
  // Utilities
  buildDateTime,
  normalizeDateKey,
  // Core functions
  findEligiblePartnersForBooking,
  getAvailableSlotsForRequest,
  getBookingWindow,
  getBlockingWindowsByPartner,
  syncPartnerOperationalState,
  isACCategory,
};
