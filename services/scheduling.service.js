const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");
const AdminSetting = require("../admin/models/AdminSetting");

const WORKDAY_START_HOUR = 9;
const WORKDAY_END_HOUR = 20;
const SLOT_GAP_MINUTES = 60;
const DEFAULT_SERVICE_DURATION_MINUTES = 60;
const DEFAULT_TRAVEL_BUFFER_MINUTES = 30;
const MAX_RADIUS_METERS = 8 * 1000;
const FAIRNESS_LOOKBACK_HOURS = 12;
const BLOCKING_BOOKING_STATUSES = [
  "ASSIGNED",
  "PARTNER_ACCEPTED",
  "ON_THE_WAY",
  "IN_PROGRESS",
];

function normalizeText(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeDateKey(dateInput) {
  const date = new Date(dateInput);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
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
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
  return { start, end };
}

function getTimeLabel(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(
    2,
    "0"
  )}`;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function toObjectIdString(value) {
  return value ? String(value).trim() : "";
}

async function loadServiceMap(serviceIds = []) {
  const ids = uniqueStrings(serviceIds);
  if (!ids.length) return new Map();

  const services = await Service.find({ _id: { $in: ids } })
    .select("_id duration category subCategory legacyCategory name isActive")
    .populate("category", "slug name")
    .populate("subCategory", "name")
    .lean();

  const serviceMap = new Map();
  for (const service of services) {
    serviceMap.set(String(service._id), service);
  }

  return serviceMap;
}

async function buildRequestContext({
  booking = null,
  serviceId = null,
  serviceCategory = null,
  services = [],
} = {}) {
  const requestServices = Array.isArray(services) && services.length
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
    ...Array.from(serviceMap.values()).map((service) =>
      service?.category?.slug || service?.category?.name || service?.legacyCategory || ""
    ),
  ]).map(normalizeText);

  const requestedSubCategories = uniqueStrings([
    ...requestServices.map((item) => item?.subCategory),
    ...Array.from(serviceMap.values()).map((service) => service?.subCategory?.name || ""),
  ]).map(normalizeText);

  return {
    requestServices,
    requestedServiceIds,
    requestedCategories,
    requestedSubCategories,
    serviceMap,
  };
}

function calculateDurationMinutesFromRequest(requestServices, serviceMap) {
  if (!requestServices?.length) {
    return DEFAULT_SERVICE_DURATION_MINUTES;
  }

  const total = requestServices.reduce((sum, item) => {
    const service = serviceMap.get(toObjectIdString(item?.serviceId));
    const duration = Math.max(Number(service?.duration) || DEFAULT_SERVICE_DURATION_MINUTES, 1);
    const quantity = Math.max(Number(item?.quantity || 1), 1);
    return sum + duration * quantity;
  }, 0);

  // Cap at 240 minutes (4 hours) so massive orders fit within the workday
  return Math.min(Math.max(total, DEFAULT_SERVICE_DURATION_MINUTES), 240);
}

async function getBookingWindow(booking) {
  const requestContext = await buildRequestContext({ booking });
  const scheduledStartAt = booking?.scheduledStartAt
    ? new Date(booking.scheduledStartAt)
    : buildDateTime(booking.scheduledDate, booking.scheduledTime);
  const rawDurationMinutes =
    Math.max(Number(booking?.estimatedDurationMinutes) || 0, 0) ||
    calculateDurationMinutesFromRequest(
      requestContext.requestServices,
      requestContext.serviceMap
    );
  const durationMinutes = Math.min(rawDurationMinutes, 240);
  const scheduledEndAt = booking?.scheduledEndAt
    ? new Date(booking.scheduledEndAt)
    : addMinutes(scheduledStartAt, durationMinutes);

  return {
    scheduledStartAt,
    scheduledEndAt,
    durationMinutes,
    requestContext,
  };
}

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

async function getBlockingWindowsByPartner(partnerIds = [], dateInput) {
  const ids = uniqueStrings(partnerIds);
  if (!ids.length) return new Map();

  const { start, end } = getDayBounds(dateInput);
  const bookings = await Booking.find({
    $or: [
      { partner: { $in: ids } },
      { additionalPartners: { $in: ids } }
    ],
    status: { $in: BLOCKING_BOOKING_STATUSES },
    scheduledDate: {
      $gte: start,
      $lt: end,
    },
  })
    .select(
      "_id partner services serviceId scheduledDate scheduledTime estimatedDurationMinutes scheduledStartAt scheduledEndAt"
    )
    .lean();

  const allServiceIds = uniqueStrings(
    bookings.flatMap((booking) => [
      booking?.serviceId,
      ...(booking?.services || []).map((item) => item?.serviceId),
    ])
  );
  const serviceMap = await loadServiceMap(allServiceIds);

  const windowsByPartner = new Map(ids.map((id) => [id, []]));

  for (const booking of bookings) {
    const partnerIdsInBooking = [
      booking.partner,
      ...(booking.get ? booking.get("additionalPartners") || [] : booking.additionalPartners || [])
    ].map(toObjectIdString).filter(Boolean);
    
    const requestServices =
      Array.isArray(booking.services) && booking.services.length
        ? booking.services
        : booking.serviceId
          ? [{ serviceId: booking.serviceId }]
          : [];

    const durationMinutes =
      Math.max(Number(booking.estimatedDurationMinutes) || 0, 0) ||
      calculateDurationMinutesFromRequest(requestServices, serviceMap);
    const startAt = booking.scheduledStartAt
      ? new Date(booking.scheduledStartAt)
      : buildDateTime(booking.scheduledDate, booking.scheduledTime);
    const endAt = booking.scheduledEndAt
      ? new Date(booking.scheduledEndAt)
      : addMinutes(startAt, durationMinutes);

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

async function syncPartnerOperationalState(partnerId) {
  const id = toObjectIdString(partnerId);
  if (!id) return null;

  const partner = await Partner.findById(id);
  if (!partner) return null;

  const blockingBookings = await Booking.find({
    partner: partner._id,
    status: { $in: BLOCKING_BOOKING_STATUSES },
  })
    .select("scheduledDate scheduledTime")
    .sort({ scheduledDate: 1, scheduledTime: 1 })
    .lean();

  const now = new Date();
  const bookingWindows = await Promise.all(
    blockingBookings.map(async (booking) => {
      const window = await getBookingWindow(booking);
      return {
        startAt: window.scheduledStartAt,
        endAt: window.scheduledEndAt,
      };
    })
  );

  // Only count jobs that are actually in progress right now.
  // Future scheduled bookings remain in busySlots, but they do not consume
  // the live activeJobs limit for every later day.
  partner.activeJobs = bookingWindows.filter(
    (window) => now >= window.startAt && now < window.endAt
  ).length;
  partner.busySlots = blockingBookings.map((booking) => ({
    date: booking.scheduledDate,
    time: booking.scheduledTime,
  }));

  await partner.save();
  return partner;
}

function windowsOverlap(candidateStart, candidateEnd, existingStart, existingEnd) {
  return candidateStart < existingEnd && candidateEnd > existingStart;
}

function isWindowAvailable(candidateWindow, existingWindows = []) {
  const bufferedStart = addMinutes(
    candidateWindow.startAt,
    -DEFAULT_TRAVEL_BUFFER_MINUTES
  );
  const bufferedEnd = addMinutes(
    candidateWindow.endAt,
    DEFAULT_TRAVEL_BUFFER_MINUTES
  );

  return !existingWindows.some((window) =>
    windowsOverlap(bufferedStart, bufferedEnd, window.startAt, window.endAt)
  );
}

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
    uniqueStrings((partner?.services || []).map((item) => item?.subCategory)).map(normalizeText)
  );
}

function getPartnerSkillMatchLevel(partner, requestContext) {
  const requestedServiceIds = requestContext.requestedServiceIds || [];
  const requestedSubCategories = requestContext.requestedSubCategories || [];
  const requestedCategories = requestContext.requestedCategories || [];

  const partnerServiceIds = collectPartnerServiceIds(partner);
  const partnerSubCategories = collectPartnerSubCategories(partner);
  const partnerCategories = collectPartnerCategories(partner);

  // 1. SMART ONBOARDED PARTNERS (Strict Check)
  if (partnerServiceIds.size > 0) {
    if (!requestedServiceIds.length) return 1; // Fallback if booking has no specific services

    const matchingCount = requestedServiceIds.filter(id => partnerServiceIds.has(id)).length;
    
    if (matchingCount === requestedServiceIds.length) {
      return 3; // Perfect Match: Partner can do EVERYTHING requested
    }
    if (matchingCount > 0) {
      return 2.5; // Partial Match: Partner can do SOME requested services (Great for team helpers)
    }
    
    // CRITICAL FIX: If they defined specific skills, but match NONE of the requested services, BLOCK THEM.
    return 0;
  }

  // 2. LEGACY PARTNERS (Broad Category Fallback)
  if (
    requestedSubCategories.length &&
    requestedSubCategories.every((subCategory) => partnerSubCategories.has(subCategory))
  ) {
    return 2;
  }

  if (
    requestedCategories.length &&
    requestedCategories.every((category) => partnerCategories.has(category))
  ) {
    return 1;
  }

  return 0;
}

const FAIRNESS_LOOKBACK_HOURS = 12;

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

  const toRadians = (value) => (value * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) ** 2;

  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

function calculateAvailabilitySlackMinutes(candidateWindow, existingWindows = []) {
  if (!existingWindows.length) return Number.POSITIVE_INFINITY;

  const futureWindows = existingWindows
    .filter((window) => window.startAt >= candidateWindow.endAt)
    .sort((a, b) => a.startAt - b.startAt);

  if (!futureWindows.length) return Number.POSITIVE_INFINITY;

  return Math.max(
    Math.round((futureWindows[0].startAt - candidateWindow.endAt) / (1000 * 60)),
    0
  );
}

function sortRankedPartners(a, b) {
  if (a.score !== b.score) {
    return b.score - a.score;
  }

  if (a.skillMatchLevel !== b.skillMatchLevel) {
    return b.skillMatchLevel - a.skillMatchLevel;
  }

  if (a.distanceMeters !== b.distanceMeters) {
    return a.distanceMeters - b.distanceMeters;
  }

  return String(a.partner?._id || "").localeCompare(String(b.partner?._id || ""));
}

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
    (Date.now() - new Date(partner.lastAssignedAt).getTime()) / (1000 * 60 * 60);
  return Math.max(0, Math.min((hoursSinceAssigned / FAIRNESS_LOOKBACK_HOURS) * 100, 100));
}

function scoreReliability(partner) {
  const ratingScore = Math.max(0, Math.min((Number(partner?.rating || 0) / 5) * 100, 100));
  const cancellationPenalty = Math.min(Number(partner?.weeklyCancelCount || 0) * 20, 60);
  return Math.max(0, ratingScore - cancellationPenalty);
}

function scoreSkillMatch(skillMatchLevel) {
  if (skillMatchLevel >= 3) return 100;
  if (skillMatchLevel >= 2.5) return 85; // Prioritize partial matches over generic legacy matches
  if (skillMatchLevel === 2) return 75;
  if (skillMatchLevel === 1) return 50;
  return 0;
}

function calculatePartnerScore({
  skillMatchLevel,
  distanceMeters,
  partner,
  earningsToday = 1
}) {
  // NEW FAIRNESS FORMULA: idleTime * 0.4 + (1 / earningsToday) * 0.3 + (1 / distance) * 0.2 + availability * 0.1
  const idleTimeHours = partner.lastAssignedAt 
    ? (Date.now() - new Date(partner.lastAssignedAt).getTime()) / (1000 * 60 * 60)
    : 24; 
  const idleScore = Math.min(idleTimeHours / FAIRNESS_LOOKBACK_HOURS, 1) * 100;

  const distanceScore = distanceMeters > 0 ? Math.min((1000 / distanceMeters) * 100, 100) : 100;
  const earningsScore = earningsToday > 0 ? Math.min((1000 / earningsToday) * 100, 100) : 100;
  const availabilityScore = scoreSkillMatch(skillMatchLevel);

  const score =
    idleScore * 0.4 +
    earningsScore * 0.3 +
    distanceScore * 0.2 +
    availabilityScore * 0.1;

  return {
    score: Math.round(score * 100) / 100,
    fairnessScore: Math.round(idleScore * 100) / 100,
    distanceScore: Math.round(distanceScore * 100) / 100,
    skillScore: Math.round(availabilityScore * 100) / 100,
    earningsScore: Math.round(earningsScore * 100) / 100,
  };
}

async function findEligiblePartnersForBooking(booking, pincodes = []) {
  const requestContext = await buildRequestContext({ booking });
  if (!requestContext.requestedServiceIds.length && !requestContext.requestedCategories.length) {
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

  if (Array.isArray(pincodes) && pincodes.length) {
    query.$or = [
      { serviceAreas: { $in: pincodes } },
      { currentPincode: { $in: pincodes } },
      { serviceAreas: { $exists: false } },
      { serviceAreas: { $size: 0 } },
    ];
  }

  if (Array.isArray(booking?.location?.coordinates) && booking.location.coordinates.length === 2) {
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
  if (!isInsideWorkday(bookingWindow.scheduledStartAt, bookingWindow.scheduledEndAt)) {
    return [];
  }

  const windowsByPartner = await getBlockingWindowsByPartner(
    partners.map((partner) => partner._id),
    booking.scheduledDate
  );

  const ranked = partners
    .map((partner) => {
      const skillMatchLevel = getPartnerSkillMatchLevel(partner, requestContext);
      if (!skillMatchLevel) return null;

      const partnerWindows = windowsByPartner.get(String(partner._id)) || [];
      const candidateWindow = {
        startAt: bookingWindow.scheduledStartAt,
        endAt: bookingWindow.scheduledEndAt,
      };

      if (!isWindowAvailable(candidateWindow, partnerWindows)) {
        return null;
      }

      // NEW REACHABILITY CHECK
      const distanceKm = calculateDistanceMeters(booking.location, partner.location) / 1000;
      const travelTimeMinutes = distanceKm * 3; // Approx 3 mins per km
      const arrivalTime = addMinutes(new Date(), travelTimeMinutes);
      
      if (distanceKm <= 5) {
        // Allow (Primary Radius)
      } else if (distanceKm <= 15 && arrivalTime <= bookingWindow.scheduledStartAt) {
        // Allow (Extended Radius + Reachable in time)
      } else if (distanceKm <= 25 && bookingWindow.scheduledStartAt > addMinutes(new Date(), 120)) {
        // Allow (Max Radius + Future Booking)
      } else {
        return null; // Reject
      }

      const distanceMeters = calculateDistanceMeters(booking.location, partner.location);
      
      // Approximate earnings today using activeJobs for fairness formula
      const earningsToday = Math.max((partner.activeJobs || 0) * 500, 1);
      
      const scoreBreakdown = calculatePartnerScore({
        skillMatchLevel,
        distanceMeters,
        partner,
        earningsToday,
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

async function getAvailableSlotsForRequest({
  date,
  serviceId = null,
  serviceCategory = null,
  services = [],
  pincode = "",
  location = null,
} = {}) {
  if (!date) {
    throw new Error("date is required");
  }

  const requestContext = await buildRequestContext({
    serviceId,
    serviceCategory,
    services,
  });
  const durationMinutes = calculateDurationMinutesFromRequest(
    requestContext.requestServices,
    requestContext.serviceMap
  );
  const now = new Date();
  const requestedDayKey = normalizeDateKey(date);
  const currentDayKey = normalizeDateKey(now);
  const isToday = requestedDayKey === currentDayKey;
  
  // NEW CAPACITY ENGINE LOGIC
  const CAPACITY_BUFFER = 0.8;
  const MAX_CAPACITY = 420; // 7 Hours per partner
  
  const activePartnersInZone = await Partner.countDocuments({
    $or: [{ serviceAreas: pincode }, { currentPincode: pincode }],
    isAvailable: true,
    isOnline: true
  });
  
  const totalCapacity = activePartnersInZone * MAX_CAPACITY * CAPACITY_BUFFER;
  
  const existingBookings = await Booking.find({
    pincode,
    scheduledDate: date,
    $or: [
      { status: { $in: ["PENDING_ASSIGNMENT", "ASSIGNED", "CONFIRMED", "PARTNER_ACCEPTED", "ON_THE_WAY", "IN_PROGRESS"] } },
      { status: "PENDING_PAYMENT", lockedUntil: { $gt: new Date() } }
    ]
  });
  
  const usedCapacity = existingBookings.reduce((sum, b) => sum + (b.lockedCapacityMinutes || b.estimatedDurationMinutes || 60), 0);
  const remainingCapacity = totalCapacity - usedCapacity;

  const slotResults = [];
  const dayStart = buildDateTime(date, `${String(WORKDAY_START_HOUR).padStart(2, "0")}:00`);
  const dayEnd = buildDateTime(date, `${String(WORKDAY_END_HOUR).padStart(2, "0")}:00`);

  for (let cursor = new Date(dayStart); cursor < dayEnd; cursor = addMinutes(cursor, SLOT_GAP_MINUTES)) {
    const slotStart = new Date(cursor);
    const slotEnd = addMinutes(slotStart, durationMinutes);

    if (isToday && slotStart.getTime() <= now.getTime()) {
      continue;
    }

    if (!isInsideWorkday(slotStart, slotEnd)) {
      continue;
    }
    
    // CAPACITY CHECK
    if (remainingCapacity < durationMinutes) {
      continue; // Slot FULL
    }

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

    if (!rankedPartners.length) {
      continue;
    }

    slotResults.push({
      time: getTimeLabel(slotStart),
      durationMinutes,
      availablePartners: rankedPartners.length,
      bestPartnerDistanceMeters: Number.isFinite(rankedPartners[0].distanceMeters)
        ? Math.round(rankedPartners[0].distanceMeters)
        : null,
    });
  }

  return slotResults;
}

module.exports = {
  BLOCKING_BOOKING_STATUSES,
  DEFAULT_SERVICE_DURATION_MINUTES,
  DEFAULT_TRAVEL_BUFFER_MINUTES,
  SLOT_GAP_MINUTES,
  WORKDAY_END_HOUR,
  WORKDAY_START_HOUR,
  buildDateTime,
  findEligiblePartnersForBooking,
  getAvailableSlotsForRequest,
  getBookingWindow,
  getBlockingWindowsByPartner,
  normalizeDateKey,
  syncPartnerOperationalState,
};
