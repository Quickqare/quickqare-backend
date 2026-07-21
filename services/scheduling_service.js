const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");
const AdminSetting = require("../admin/models/AdminSetting");
const LearnedStat = require("../models/LearnedStat");
const {
  isZoneServiceEnabled,
  resolveZoneForPincode,
} = require("./zone.service");
const { deriveH3Cell, getH3Ring } = require("../utils/h3");
const {
  isCakeCategoryText,
  CAKE_CATEGORY_REGEX,
} = require("../utils/categoryDetection");
const { getUseH3Flag } = require("./useH3Flag.service");

/*
=====================================================
CONSTANTS
=====================================================
*/
const WORKDAY_START_HOUR = 9;
const WORKDAY_END_HOUR = 20;
// Late-day jobs (e.g. 150-min AC gas refill starting at 18:00) finish past 20:00.
// Allow end time up to 21:00 so the slot is not suppressed.
const WORKDAY_END_GRACE_HOUR = 21;
const SLOT_GAP_MINUTES = 60;
const DEFAULT_SERVICE_DURATION_MINUTES = 60;
const DEFAULT_TRAVEL_BUFFER_MINUTES = 30;

// AC bookings: 45-minute travel/prep buffer (equipment carry overhead)
const AC_TRAVEL_BUFFER_MINUTES = 45;

// Distance-scaled transit buffer between consecutive jobs. Computed from the
// two BOOKING addresses (snapshotted at booking time — unlike partner live
// GPS these can never be stale or missing mid-assignment; partner GPS is
// never consulted for buffers, only for ranking). When either booking has no
// usable location the flat legacy buffer above applies, so bad or absent
// coordinates always degrade to the conservative behaviour — never a
// shorter gap.
const TRAVEL_MINUTES_PER_KM = 3;          // ~20 km/h door-to-door city average
const TRAVEL_BUFFER_BASE_MINUTES = 10;    // parking, stairs, payment, wrap-up
const AC_TRAVEL_BUFFER_BASE_MINUTES = 15; // + equipment carry
const TRAVEL_BUFFER_MAX_MINUTES = 60;     // extended-pincode trips cap here

// AC bookings: 360 min max per technician (physically heavier, more variable)
const AC_MAX_CAPACITY_MINUTES = 360;

// General / Mehendi: 420 min max (7 hours)
const GENERAL_MAX_CAPACITY_MINUTES = 420;

// Maximum on-site elapsed time PER PARTNER at a single visit. This caps each
// task bin so team size is driven by how long the customer's event/visit can
// realistically run — a 10-hour guest-mehendi party gets enough artists to
// finish inside the event window, not one artist working 7 hours straight.
const MEHENDI_VISIT_WINDOW_MINUTES = 240; // typical mehendi function: 3-4 h
const AC_VISIT_WINDOW_MINUTES = 240;      // max time one tech spends at a home

// Units after the first of the same AC service line are faster — the tech is
// already on-site with tools set up. Scheduling time only; pricing unchanged.
const AC_ADDITIONAL_UNIT_FACTOR = 0.75;

// Bridal mehendi: this many artists work the bride in parallel (one per side),
// so each artist carries duration / BRIDAL_ARTISTS_PER_BRIDE of the work.
const BRIDAL_ARTISTS_PER_BRIDE = 2;

// Name-based fallbacks for services without an explicit packingRole (legacy
// rows created before the field existed). New/edited services should set
// Service.packingRole so an admin rename can't silently change team sizing.
const MEHENDI_ADDON_FEET_NAMES = ["basic feet", "feet", "ankle", "above ankle"];
const MEHENDI_INDEPENDENT_NAMES = ["mid leg", "below knee", "mehendi for guests"];

const MAX_RADIUS_METERS = 8 * 1000;
const FAIRNESS_LOOKBACK_HOURS = 12;

// AC category detection slugs — extend this list as needed
const AC_CATEGORY_SLUGS = ["ac", "air conditioner", "air-conditioner", "aircon"];

// Cake/Celebration: a baker can hold at most this many cake orders per
// scheduled calendar day. Enforced in findEligiblePartnersForBooking, which
// also feeds slot listing and slot capacity — so full bakers automatically
// stop appearing as available. This is the CODE DEFAULT; admin can override
// it via AdminSetting.assignment.cakeMaxOrdersPerPartnerPerDay.
const CAKE_MAX_ORDERS_PER_PARTNER_PER_DAY = 2;

// Cached admin override for the cake daily cap (60s TTL, same pattern as the
// useH3Zones flag). Falls back to the code default on any error.
let _cakeCapCache = { value: CAKE_MAX_ORDERS_PER_PARTNER_PER_DAY, expiresAt: 0 };
async function getCakeDailyCap() {
  if (Date.now() < _cakeCapCache.expiresAt) return _cakeCapCache.value;
  try {
    const s = await AdminSetting.findOne().select("assignment").lean();
    const v = Math.floor(Number(s?.assignment?.cakeMaxOrdersPerPartnerPerDay));
    _cakeCapCache = {
      value: Number.isFinite(v) && v >= 1 ? v : CAKE_MAX_ORDERS_PER_PARTNER_PER_DAY,
      expiresAt: Date.now() + 60_000,
    };
  } catch {
    _cakeCapCache.expiresAt = Date.now() + 10_000;
  }
  return _cakeCapCache.value;
}

/*
=====================================================
SCORE WEIGHTS (single source of truth)
Exported so the weight-shadow report (cron) can replay the exact live
formula and compare it against a candidate weighting. Each set sums to
1.0. Reliability is a real component now (was dead code): a partner's
rating, acceptance rate, cancellations and no-shows finally move their
rank instead of only mattering at the 5-strike auto-suspend cliff.

AC keeps skill dominant (a wrong-tier tech wastes 45+ min); general work
leans on fairness/earnings balance. Both carve 0.15 out of the old
idle/earnings weights for reliability.
=====================================================
*/
const AC_SCORE_WEIGHTS = { idle: 0.28, earnings: 0.17, distance: 0.1, skill: 0.3, reliability: 0.15 };
const GENERAL_SCORE_WEIGHTS = { idle: 0.33, earnings: 0.22, distance: 0.2, skill: 0.1, reliability: 0.15 };

// Learned service duration is clamped to this band around the admin-entered
// `duration`, so a single corrupt timestamp can never blow up team sizing or
// slot capacity. +/-40%. A service needs at least MIN_SAMPLES completed-job
// observations before its learned value is trusted over the admin value.
const LEARNED_DURATION_MIN_FACTOR = 0.6;
const LEARNED_DURATION_MAX_FACTOR = 1.4;
const LEARNED_DURATION_MIN_SAMPLES = 5;

/**
 * Effective on-site minutes for one unit of a service: the learned duration
 * when the cron has gathered enough samples, else the admin-entered duration,
 * always clamped to +/-40% of the admin value. `fallback` is used when the
 * service ref is missing entirely (unpopulated line).
 */
function serviceDurationMinutes(serviceRef, fallback = DEFAULT_SERVICE_DURATION_MINUTES) {
  const base = Math.max(Number(serviceRef?.duration) || fallback, 1);
  const learned = Number(serviceRef?.learnedDurationMinutes);
  const samples = Number(serviceRef?.learnedDurationSamples) || 0;
  if (!Number.isFinite(learned) || learned <= 0 || samples < LEARNED_DURATION_MIN_SAMPLES) {
    return base;
  }
  const lo = base * LEARNED_DURATION_MIN_FACTOR;
  const hi = base * LEARNED_DURATION_MAX_FACTOR;
  return Math.round(Math.min(Math.max(learned, lo), hi));
}

// Learned transit time (minutes) per category, refreshed by the nightly
// learnTravelTimes cron from real onTheWayAt -> arrivedAt observations. These
// are the code defaults / clamps; the cron never pushes a value outside the
// [min,max] band, so a bad batch can't produce an absurd buffer.
const TRAVEL_BUFFER_GENERAL_MIN = 15;
const TRAVEL_BUFFER_GENERAL_MAX = 60;
const TRAVEL_BUFFER_AC_MIN = 20;
const TRAVEL_BUFFER_AC_MAX = 75;

// Cached learned transit times (60s TTL, same pattern as the cake cap). Falls
// back to the hardcoded DEFAULT_/AC_TRAVEL_BUFFER_MINUTES on any miss.
let _travelBufferCache = { general: null, ac: null, expiresAt: 0 };
async function getLearnedTravelBuffers() {
  if (Date.now() < _travelBufferCache.expiresAt) return _travelBufferCache;
  try {
    const doc = await LearnedStat.findOne({ key: "travelBuffer" }).lean();
    const g = Number(doc?.data?.general);
    const a = Number(doc?.data?.ac);
    _travelBufferCache = {
      general: Number.isFinite(g) && g > 0 ? g : null,
      ac: Number.isFinite(a) && a > 0 ? a : null,
      expiresAt: Date.now() + 60_000,
    };
  } catch {
    _travelBufferCache = { general: null, ac: null, expiresAt: Date.now() + 10_000 };
  }
  return _travelBufferCache;
}

/**
 * SYNC read of the learned flat transit buffer (minutes) for a category, for
 * the hot sync scoring path (travelBufferMinutesForDistance). Returns the
 * learned value (clamped to the category band as defence-in-depth) when the
 * module cache is warm and populated, else the hardcoded flat buffer. The
 * cache is warmed by getLearnedTravelBuffers(), which every findEligible /
 * getBookingWindow call awaits before the sync ranking loop runs.
 */
function cachedFlatTravelBuffer(isAC) {
  const learned = isAC ? _travelBufferCache.ac : _travelBufferCache.general;
  const fallback = isAC ? AC_TRAVEL_BUFFER_MINUTES : DEFAULT_TRAVEL_BUFFER_MINUTES;
  if (!Number.isFinite(learned) || learned <= 0) return fallback;
  const lo = isAC ? TRAVEL_BUFFER_AC_MIN : TRAVEL_BUFFER_GENERAL_MIN;
  const hi = isAC ? TRAVEL_BUFFER_AC_MAX : TRAVEL_BUFFER_GENERAL_MAX;
  return Math.min(Math.max(Math.round(learned), lo), hi);
}

// Statuses that count toward the baker's daily cake cap. Pre-assignment
// statuses are excluded (no partner attached yet); COMPLETED counts because a
// cake delivered earlier the same day still consumed baking capacity.
const CAKE_CAP_COUNT_STATUSES = [
  "ASSIGNED",
  "CONFIRMED",
  "PARTNER_ACCEPTED",
  "ON_THE_WAY",
  "ARRIVED",
  "IN_PROGRESS",
  "COMPLETED",
];

// Statuses where a partner is committed to a booking and that booking's window
// must block them from being assigned to overlapping work.
// CONFIRMED: auto-accept partners skip ASSIGNED and land here directly.
// ARRIVED: partner is on-site; they cannot serve another booking until done.
const BLOCKING_BOOKING_STATUSES = [
  "ASSIGNED",
  "CONFIRMED",
  "PARTNER_ACCEPTED",
  "ON_THE_WAY",
  "ARRIVED",
  "IN_PROGRESS",
];

// Statuses where a booking holds capacity in the pincode (regardless of whether
// a specific partner is attached). Used for the slot-capacity pre-filter and the
// createBooking double-book guard. Includes pre-assignment statuses (SEARCHING,
// PENDING_ASSIGNMENT, ASSIGNING_LOCK, QUEUED) because those bookings are in
// flight and will land on a partner momentarily — we must reserve their capacity.
const SLOT_HOLDING_BOOKING_STATUSES = [
  "PENDING_ASSIGNMENT",
  "QUEUED",
  "SEARCHING",
  "ASSIGNING_LOCK",
  "ASSIGNED",
  "CONFIRMED",
  "PARTNER_ACCEPTED",
  "ON_THE_WAY",
  "ARRIVED",
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
  if (isNaN(date.getTime())) {
    throw new Error(`buildDateTime: invalid date "${dateInput}"`);
  }

  const timeParts = String(time || "00:00").split(":");
  const hours   = Number(timeParts[0]) || 0;
  const minutes = Number(timeParts[1]) || 0;

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`buildDateTime: invalid time "${time}" — hours must be 0-23, minutes 0-59`);
  }

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
  if (!normalized) return false;
  // "ac" is far too short for substring matching — "facial", "package",
  // "black" all contain it and would be misclassified as air-conditioning.
  // Match the short slugs as whole words; the multi-word slug is a safe
  // substring ("air-conditioner" normalizes to "air conditioner" too).
  const tokens = normalized.split(" ");
  if (tokens.includes("ac") || tokens.includes("aircon")) return true;
  return normalized.includes("air conditioner");
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
    .select("_id duration category subCategory legacyCategory name isActive skillTier packingRole")
    .populate("category", "slug name categoryType")
    .populate("subCategory", "name")
    .lean();

  return new Map(services.map((s) => [String(s._id), s]));
}

/*
=====================================================
TEAM TASK PACKER
Shared by the assignment engine (team sizing + payout
split), slot listing (feasibility) and the duration
calculator (elapsed makespan). One packing model so
"how many partners", "who can staff which share" and
"how long the visit takes" can never disagree.
=====================================================
*/
function isMehendiLine(serviceRef, line) {
  if (serviceRef?.packingRole) return true;
  const cat = normalizeText(
    line?.category || serviceRef?.category?.slug || serviceRef?.legacyCategory || ""
  );
  const name = normalizeText(line?.name || serviceRef?.name || "");
  return cat.includes("mehendi") || name.includes("mehendi");
}

function getMehendiPackingRole(serviceRef, line) {
  if (serviceRef?.packingRole) return serviceRef.packingRole;
  const name = normalizeText(line?.name || serviceRef?.name || "");
  if (name.includes("bridal mehendi")) return "BRIDAL";
  if (MEHENDI_ADDON_FEET_NAMES.some((n) => name === n)) return "FEET_ADDON";
  if (MEHENDI_INDEPENDENT_NAMES.some((n) => name === n)) return "INDEPENDENT";
  return "HAND";
}

/**
 * Packs task minutes into per-partner bins no larger than the visit window.
 * Phase 1 (FFD) finds the minimum bin count; phase 2 redistributes the
 * tier-1 tasks LPT-style across that same count so no partner carries a
 * lopsided share (even payouts, shortest on-site makespan). Tier-2 tasks
 * stay where FFD concentrated them — spreading them across bins would
 * demand more technicians than the packing actually needs.
 */
function packBalancedBins(tasks, capacityMinutes) {
  if (!tasks.length) return [];
  const sorted = [...tasks].sort(
    (a, b) => b.tier - a.tier || b.minutes - a.minutes
  );

  const ffdBins = [];
  for (const task of sorted) {
    const bin = ffdBins.find((b) => b.minutes + task.minutes <= capacityMinutes);
    if (bin) {
      bin.minutes += task.minutes;
      bin.tier = Math.max(bin.tier, task.tier);
      bin.tasks.push(task);
    } else {
      ffdBins.push({ minutes: task.minutes, tier: task.tier, tasks: [task] });
    }
  }

  if (ffdBins.length > 1) {
    const rebalanced = ffdBins.map((b) => {
      const pinned = b.tasks.filter((t) => t.tier >= 2);
      return {
        minutes: pinned.reduce((sum, t) => sum + t.minutes, 0),
        tier: pinned.length ? Math.max(...pinned.map((t) => t.tier)) : 1,
      };
    });
    let feasible = true;
    for (const task of sorted) {
      if (task.tier >= 2) continue; // pinned above
      let best = null;
      for (const bin of rebalanced) {
        if (bin.minutes + task.minutes > capacityMinutes) continue;
        if (!best || bin.minutes < best.minutes) best = bin;
      }
      if (!best) {
        feasible = false;
        break;
      }
      best.minutes += task.minutes;
    }
    if (feasible) {
      return rebalanced
        .filter((b) => b.minutes > 0)
        .map((b) => ({ minutes: b.minutes, tier: b.tier }));
    }
  }

  return ffdBins.map((b) => ({ minutes: b.minutes, tier: b.tier }));
}

/**
 * Builds the team plan for a cart: how many partners, each partner's share
 * (bin) with its skill requirements, and the elapsed makespan.
 *
 * Bins: { minutes, tier (1|2 — AC), kind ("BRIDAL" | "GUEST") }.
 * Non-team categories (cake, plumbing, …) return a single-partner plan with
 * no bins — callers treat that as "one partner does the whole job".
 */
function packTeamTasks(requestServices, serviceMap, { isAC = false, isMehendi = false } = {}) {
  const singlePartner = {
    requiredCount: 1,
    bins: [],
    dedicatedMinutes: [],
    taskBins: [],
    makespanMinutes: 0,
  };
  if (!Array.isArray(requestServices) || !requestServices.length) {
    return { ...singlePartner, taskBins: [0] };
  }
  if (!isAC && !isMehendi) return singlePartner;

  const dedicatedBins = [];
  const handTasks = [];
  const addonFeetTasks = [];
  const independentTasks = [];

  if (isAC) {
    for (const line of requestServices) {
      const ref = serviceMap.get(toObjectIdString(line?.serviceId));
      const duration = serviceDurationMinutes(ref, 90);
      const tier = Number(ref?.skillTier) === 2 ? 2 : 1;
      const quantity = Math.max(Number(line?.quantity || 1), 1);
      for (let i = 0; i < quantity; i += 1) {
        const minutes =
          i === 0
            ? duration
            : Math.max(Math.round(duration * AC_ADDITIONAL_UNIT_FACTOR), 1);
        handTasks.push({ minutes, tier });
      }
    }
  } else {
    for (const line of requestServices) {
      const ref = serviceMap.get(toObjectIdString(line?.serviceId));
      const duration = serviceDurationMinutes(ref, 60);
      const quantity = Math.max(Number(line?.quantity || 1), 1);
      // Non-mehendi lines in a mixed cart still consume an artist's time.
      const role = isMehendiLine(ref, line)
        ? getMehendiPackingRole(ref, line)
        : "INDEPENDENT";

      if (role === "BRIDAL") {
        // Artists work the bride in parallel — each carries half the catalog
        // duration, both for payout weight and for the elapsed makespan.
        const perArtist = Math.ceil(duration / BRIDAL_ARTISTS_PER_BRIDE);
        for (let q = 0; q < quantity * BRIDAL_ARTISTS_PER_BRIDE; q += 1) {
          dedicatedBins.push({ minutes: perArtist, tier: 1, kind: "BRIDAL" });
        }
      } else {
        const bucket =
          role === "FEET_ADDON"
            ? addonFeetTasks
            : role === "INDEPENDENT"
            ? independentTasks
            : handTasks;
        for (let q = 0; q < quantity; q += 1) {
          bucket.push({ minutes: duration, tier: 1 });
        }
      }
    }
  }

  // Pair each feet add-on with a hand task (same guest, one artist) — largest
  // with largest so combined blocks stay as even as possible.
  handTasks.sort((a, b) => b.minutes - a.minutes);
  addonFeetTasks.sort((a, b) => b.minutes - a.minutes);
  const taskList = [];
  for (const feet of addonFeetTasks) {
    const hand = handTasks.shift();
    taskList.push(
      hand
        ? { minutes: hand.minutes + feet.minutes, tier: Math.max(hand.tier, feet.tier) }
        : feet
    );
  }
  taskList.push(...handTasks, ...independentTasks);

  const visitWindow = isAC ? AC_VISIT_WINDOW_MINUTES : MEHENDI_VISIT_WINDOW_MINUTES;
  const guestBins = packBalancedBins(taskList, visitWindow).map((b) => ({
    minutes: b.minutes,
    tier: b.tier,
    kind: "GUEST",
  }));
  const bins = [...dedicatedBins, ...guestBins];

  return {
    requiredCount: Math.max(bins.length, 1),
    bins,
    dedicatedMinutes: dedicatedBins.map((b) => b.minutes),
    taskBins: guestBins.map((b) => b.minutes),
    makespanMinutes: bins.reduce((max, b) => Math.max(max, b.minutes), 0),
  };
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

  // Skip raw MongoDB ObjectId strings (24-char hex) — booking.services stores
  // subCategory as an unpopulated ObjectId. Only keep human-readable names so
  // the Mehendi specialization gate doesn't compare "69b06b..." against "bridal".
  const isMongoId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));

  const requestedSubCategories = uniqueStrings([
    ...requestServices.map((item) => {
      const sc = item?.subCategory;
      return isMongoId(sc) ? "" : (sc || "");
    }),
    ...Array.from(serviceMap.values()).map(
      (service) => service?.subCategory?.name || ""
    ),
  ]).map(normalizeText);

  // Admin-declared category types (Category.categoryType) — rename-proof
  // signal that takes precedence over name matching. Additive only: GENERAL
  // means "not declared", so the string fallbacks below still apply and
  // legacy data keeps behaving exactly as before.
  const declaredTypes = new Set(
    Array.from(serviceMap.values())
      .map((service) => service?.category?.categoryType)
      .filter((t) => t && t !== "GENERAL")
  );

  // Determine if this is an AC booking for downstream routing
  const isAC =
    declaredTypes.has("AC") ||
    requestedCategories.some(isACCategory) ||
    isACCategory(booking?.serviceCategory || "");

  // Determine if this is a Mehendi booking — used by the specialization gate.
  const isMehendi =
    declaredTypes.has("MEHENDI") ||
    requestedCategories.some((c) => c.includes("mehendi")) ||
    normalizeText(booking?.serviceCategory || "").includes("mehendi");

  // Determine if this is a Cake/Celebration booking — drives the per-baker
  // daily order cap and the advance-only lead-time gate.
  const isCake =
    declaredTypes.has("CELEBRATION") ||
    requestedCategories.some(isCakeCategoryText) ||
    isCakeCategoryText(booking?.serviceCategory || "");

  // Advance-only lead time (calendar days) — max across requested services.
  const minLeadDays = Math.max(
    0,
    ...Array.from(serviceMap.values()).map((s) => Number(s?.minLeadDays) || 0)
  );

  // For AC: derive the required skill tiers from the cart.
  // 1 = serviceman (cleaning/filter wash), 2 = technician (gas, repair,
  // install/uninstall). Max drives "does any task need a technician";
  // min drives the hard eligibility gate — a tier-1 partner is still a valid
  // TEAM MEMBER for a mixed cart (they take the cleaning bins) and is only
  // blocked when every task requires a technician.
  let requiredSkillTier = null;
  let minRequiredSkillTier = null;
  if (isAC) {
    const serviceTiers = Array.from(serviceMap.values())
      .map((s) => Number(s.skillTier || 1))
      .filter(Number.isFinite);
    requiredSkillTier = serviceTiers.length ? Math.max(...serviceTiers) : 1;
    minRequiredSkillTier = serviceTiers.length ? Math.min(...serviceTiers) : 1;
  }

  // Mehendi: split the requested subcategories into bridal vs guest work for
  // the specialization gate. Add-on lines (feet add-ons / the "Add-on
  // services" bucket) carry no specialization requirement — a bridal
  // specialist obviously covers the feet add-on on the same bride.
  const mehendiBridalSubCategories = [];
  const mehendiGuestSubCategories = [];
  if (isMehendi) {
    for (const line of requestServices) {
      const ref = serviceMap.get(toObjectIdString(line?.serviceId));
      if (!isMehendiLine(ref, line)) continue;
      const role = getMehendiPackingRole(ref, line);
      if (role === "FEET_ADDON") continue;
      const rawSub = isMongoId(line?.subCategory) ? "" : line?.subCategory;
      const sub = normalizeText(rawSub || ref?.subCategory?.name || "");
      if (!sub || sub === "add on services") continue;
      if (role === "BRIDAL") mehendiBridalSubCategories.push(sub);
      else mehendiGuestSubCategories.push(sub);
    }
  }

  // Single packing model shared by team sizing, slot feasibility and the
  // elapsed-duration calculator.
  const teamPack = packTeamTasks(requestServices, serviceMap, { isAC, isMehendi });

  return {
    requestServices,
    requestedServiceIds,
    requestedCategories,
    requestedSubCategories,
    serviceMap,
    isAC,
    isMehendi,
    isCake,
    minLeadDays,
    requiredSkillTier,
    minRequiredSkillTier,
    mehendiBridalSubCategories: [...new Set(mehendiBridalSubCategories)],
    mehendiGuestSubCategories: [...new Set(mehendiGuestSubCategories)],
    teamPack,
  };
}

/*
=====================================================
DURATION CALCULATOR
Team categories (AC / mehendi) use the packed
makespan: partners work in parallel, so the booking's
elapsed time is the longest single partner's share,
not the sum of all durations. Other categories keep
the summed duration (single partner does everything).
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

  const maxDuration = isAC ? AC_MAX_CAPACITY_MINUTES : 240;

  const isMehendi = requestServices.some((line) =>
    isMehendiLine(serviceMap.get(toObjectIdString(line?.serviceId)), line)
  );
  if (isAC || isMehendi) {
    const { makespanMinutes } = packTeamTasks(requestServices, serviceMap, {
      isAC,
      isMehendi,
    });
    if (makespanMinutes > 0) {
      return Math.min(
        Math.max(makespanMinutes, DEFAULT_SERVICE_DURATION_MINUTES),
        maxDuration
      );
    }
  }

  const total = requestServices.reduce((sum, item) => {
    const service = serviceMap.get(toObjectIdString(item?.serviceId));
    const duration = serviceDurationMinutes(service, DEFAULT_SERVICE_DURATION_MINUTES);
    const quantity = Math.max(Number(item?.quantity || 1), 1);
    return sum + duration * quantity;
  }, 0);

  return Math.min(Math.max(total, DEFAULT_SERVICE_DURATION_MINUTES), maxDuration);
}

/**
 * Booking-controller entry point: loads the service docs itself and returns
 * the (team-aware) elapsed duration for the cart.
 */
async function calculateDurationForServices(requestServices, { isAC = false } = {}) {
  const serviceMap = await loadServiceMap(
    (requestServices || []).map((s) => s?.serviceId)
  );
  return calculateDurationMinutesFromRequest(requestServices, serviceMap, isAC);
}

/**
 * Assignment-engine entry point: full team pack for a persisted booking
 * (bins with skill requirements, required partner count, makespan).
 */
async function computeTeamPackForBooking(booking) {
  const requestContext = await buildRequestContext({ booking });
  return requestContext.teamPack;
}

/*
=====================================================
BOOKING WINDOW RESOLVER
=====================================================
*/
async function getBookingWindow(booking) {
  const requestContext = await buildRequestContext({ booking });
  // Warm the learned-buffer cache (60s TTL) so the flat travel buffer here AND
  // the sync travelBufferMinutesForDistance fallback both see the learned value.
  await getLearnedTravelBuffers();
  const travelBuffer = cachedFlatTravelBuffer(requestContext.isAC);

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

  // scheduledEndAt is the RAW service end (used for workday gating and the
  // pairwise overlap/transit-gap checks). blockEndAt adds the FLAT buffer on
  // top and is used by syncPartnerOperationalState's live activeJobs count —
  // the partner is still "busy" while packing up and travelling away, and a
  // conservative flat buffer is right when the next destination is unknown.
  const durationMinutes = rawDurationMinutes;
  const scheduledEndAt = booking?.scheduledEndAt
    ? new Date(booking.scheduledEndAt)
    : addMinutes(scheduledStartAt, durationMinutes);
  const blockEndAt = addMinutes(scheduledEndAt, travelBuffer);

  return {
    scheduledStartAt,
    scheduledEndAt,
    blockEndAt,
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
  const y = startAt.getFullYear();
  const mo = startAt.getMonth();
  const d = startAt.getDate();
  const workdayStart = new Date(y, mo, d, WORKDAY_START_HOUR, 0, 0, 0);
  const workdayEnd   = new Date(y, mo, d, WORKDAY_END_HOUR, 0, 0, 0);
  // End time may overflow by up to 1 hour for long late-day jobs
  const workdayGrace = new Date(y, mo, d, WORKDAY_END_GRACE_HOUR, 0, 0, 0);
  return startAt >= workdayStart && startAt < workdayEnd && endAt <= workdayGrace;
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

  // Both roles: bookings where this partner is PRIMARY *or* an additional team
  // member block their calendar. Previously only primary bookings were counted,
  // so any sync for a team member erased their busySlots claim for team jobs —
  // silently disabling the assignment engine's double-booking guard for them.
  const blockingBookings = await Booking.find({
    $or: [{ partner: partner._id }, { additionalPartners: partner._id }],
    status: { $in: BLOCKING_BOOKING_STATUSES },
  })
    .select("scheduledDate scheduledTime estimatedDurationMinutes serviceCategory scheduledStartAt scheduledEndAt")
    .sort({ scheduledDate: 1, scheduledTime: 1 })
    .lean();

  const now = new Date();
  const bookingWindows = await Promise.all(
    blockingBookings.map(async (b) => {
      const window = await getBookingWindow(b);
      // blockEndAt includes the transit buffer — the partner is still "busy"
      // while travelling away from the job.
      return { startAt: window.scheduledStartAt, endAt: window.blockEndAt };
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
Windows carry RAW service start/end plus the booking
location; the transit gap between two adjacent jobs
is distance-scaled from the two customer addresses.
=====================================================
*/
function windowsOverlap(cStart, cEnd, eStart, eEnd) {
  return cStart < eEnd && cEnd > eStart;
}

/**
 * Required transit gap (minutes) between two consecutive jobs this far apart.
 * Unknown distance (either booking lacks usable coordinates) falls back to
 * the flat legacy buffer — never a shorter gap than today's behaviour.
 */
function travelBufferMinutesForDistance(distanceMeters, isAC = false) {
  if (!Number.isFinite(distanceMeters)) {
    // Unknown distance -> the flat door-to-door buffer, which is exactly what
    // the learned onTheWayAt->arrivedAt observations measure.
    return cachedFlatTravelBuffer(isAC);
  }
  const base = isAC ? AC_TRAVEL_BUFFER_BASE_MINUTES : TRAVEL_BUFFER_BASE_MINUTES;
  const travel = Math.ceil((distanceMeters / 1000) * TRAVEL_MINUTES_PER_KM);
  return Math.min(base + travel, TRAVEL_BUFFER_MAX_MINUTES);
}

function isWindowAvailable(candidateWindow, existingWindows = []) {
  return !existingWindows.some((w) => {
    if (
      windowsOverlap(
        candidateWindow.startAt,
        candidateWindow.endAt,
        w.startAt,
        w.endAt
      )
    ) {
      return true;
    }
    // Jobs don't overlap — enforce the transit gap between the earlier job's
    // end and the later one's start. AC on either side means equipment carry,
    // so the AC profile applies to the trip.
    const acProfile = Boolean(candidateWindow.isAC || w.isAC);
    const gapMs =
      travelBufferMinutesForDistance(
        calculateDistanceMeters(candidateWindow.location, w.location),
        acProfile
      ) *
      60 *
      1000;
    if (candidateWindow.startAt >= w.endAt) {
      return candidateWindow.startAt.getTime() - w.endAt.getTime() < gapMs;
    }
    return w.startAt.getTime() - candidateWindow.endAt.getTime() < gapMs;
  });
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
      "_id partner additionalPartners services serviceId scheduledDate scheduledTime estimatedDurationMinutes scheduledStartAt scheduledEndAt serviceCategory location"
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

    const startAt = booking.scheduledStartAt
      ? new Date(booking.scheduledStartAt)
      : buildDateTime(booking.scheduledDate, booking.scheduledTime);

    // RAW service end — no buffer baked in. The transit gap between this job
    // and any adjacent one is computed pairwise in isWindowAvailable from the
    // two booking addresses (distance-scaled, flat fallback when unknown).
    const endAt = booking.scheduledEndAt
      ? new Date(booking.scheduledEndAt)
      : addMinutes(startAt, durationMinutes);

    for (const partnerId of partnerIdsInBooking) {
      if (windowsByPartner.has(partnerId)) {
        windowsByPartner.get(partnerId).push({
          bookingId: String(booking._id),
          startAt,
          endAt,
          location: booking.location || null,
          isAC: bookingIsAC,
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

/**
 * Which team roles this partner can staff for the request. Real crews are
 * mixed — 2 bridal specialists + N guest artists, 1 technician + helpers —
 * so eligibility asks "can they staff at least one bin", and the team
 * planner matches partners to the specific bins they qualify for.
 * Partners with no declared specializations (legacy signups) can staff
 * anything, matching the gate's historical behaviour.
 */
function getPartnerTeamCapabilities(partner, requestContext) {
  const {
    isMehendi,
    mehendiBridalSubCategories = [],
    mehendiGuestSubCategories = [],
  } = requestContext;

  if (!isMehendi) return { canBridal: true, canGuest: true };

  const declared = (partner.mehendiSpecializations || [])
    .map(normalizeText)
    .filter(Boolean);
  if (!declared.length) return { canBridal: true, canGuest: true };

  const declaredSet = new Set(declared);
  return {
    canBridal: mehendiBridalSubCategories.every((sc) => declaredSet.has(sc)),
    canGuest: mehendiGuestSubCategories.every((sc) => declaredSet.has(sc)),
  };
}

function getPartnerSkillMatchLevel(partner, requestContext) {
  const {
    requestedServiceIds,
    requestedSubCategories,
    requestedCategories,
    isAC,
    isMehendi,
    minRequiredSkillTier,
    teamPack,
  } = requestContext;

  // AC SKILL GATE: block a partner only when EVERY task in the cart requires
  // a technician tier above theirs. A serviceman (tier 1) stays eligible for
  // a mixed cart (gas refill + cleanings) as a team member — the team planner
  // assigns the technician-tier bins to technicians only.
  if (isAC && minRequiredSkillTier >= 2) {
    const partnerTier = Number(partner.skillTier || 1);
    if (partnerTier < minRequiredSkillTier) return 0;
  }

  // MEHENDI SPECIALIZATION GATE: a partner who declared which Mehendi types
  // they perform (e.g. Bridal, Arabic) must be able to staff at least one of
  // the booking's bins — bridal work if they cover the bridal subcategories,
  // guest work if they cover the guest ones. Feet add-ons imply no
  // specialization of their own (see buildRequestContext).
  if (isMehendi) {
    const caps = getPartnerTeamCapabilities(partner, requestContext);
    const bins = teamPack?.bins || [];
    const hasBridalBins = bins.some((b) => b.kind === "BRIDAL");
    const hasGuestBins = bins.some((b) => b.kind === "GUEST");
    const canStaffSomething =
      (hasBridalBins && caps.canBridal) ||
      (hasGuestBins && caps.canGuest) ||
      (!hasBridalBins && !hasGuestBins);
    if (!canStaffSomething) return 0;
  }

  const partnerServiceIds = collectPartnerServiceIds(partner);
  const partnerSubCategories = collectPartnerSubCategories(partner);
  const partnerCategories = collectPartnerCategories(partner);

  // Legacy partners may not yet have migrated service snapshots.
  // If admin zone already allows the booking category, keep them eligible
  // instead of collapsing every slot to zero.
  if (
    partnerServiceIds.size === 0 &&
    partnerSubCategories.size === 0 &&
    partnerCategories.size === 0
  ) {
    return 1;
  }

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

  // [0,0] is the schema default, not a real partner/customer location.
  // Treat it as unknown so it does not block zone-based slot availability.
  if ((lng1 === 0 && lat1 === 0) || (lng2 === 0 && lat2 === 0)) {
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

// Acceptance-rate prior (Laplace smoothing): new / low-sample partners sit near
// this neutral-good rate and need real evidence to move it, so cold-start
// neither unfairly punishes a fresh partner nor rewards one with no history.
const ACCEPTANCE_PRIOR_ACCEPTS = 4;
const ACCEPTANCE_PRIOR_TOTAL = 5; // prior acceptance rate ~= 0.8

/**
 * Reliability score (0-100) — how much we trust this partner to actually take
 * and complete the job. Was previously dead code (defined, never called); now
 * a real component of calculatePartnerScore. Blends:
 *   - star rating (customer satisfaction)
 *   - smoothed acceptance rate (assignedCount vs acceptedCount) — the direct
 *     lever against reassignment churn: a partner who ignores 60% of offers
 *     scores low and stops winning the top slot
 * then subtracts penalties for recent cancellations and lifetime no-shows.
 */
function scoreReliability(partner) {
  const ratingScore = Math.max(
    0,
    Math.min((Number(partner?.rating ?? 5) / 5) * 100, 100)
  );

  const assigned = Math.max(Number(partner?.assignedCount || 0), 0);
  const accepted = Math.max(Number(partner?.acceptedCount || 0), 0);
  const acceptanceRate =
    (accepted + ACCEPTANCE_PRIOR_ACCEPTS) / (assigned + ACCEPTANCE_PRIOR_TOTAL);
  const acceptanceScore = Math.max(0, Math.min(acceptanceRate * 100, 100));

  const cancelPenalty = Math.min(Number(partner?.weeklyCancelCount || 0) * 15, 45);
  const noShowPenalty = Math.min(Number(partner?.noShowCount || 0) * 10, 40);

  const base = ratingScore * 0.5 + acceptanceScore * 0.5;
  return Math.max(0, base - cancelPenalty - noShowPenalty);
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
Weights differ for AC vs general/mehendi (see AC_SCORE_WEIGHTS /
GENERAL_SCORE_WEIGHTS — the single source of truth, also replayed by the
weight-shadow report):
  AC:      skill 0.30 | idle 0.28 | earnings 0.17 | distance 0.10 | reliability 0.15
  General: skill 0.10 | idle 0.33 | earnings 0.22 | distance 0.20 | reliability 0.15

Rationale: For AC, correct skill level matters more than proximity.
A Level 3 technician 12 km away is more valuable than a Level 1 partner
2 km away for a gas-charging job. Wrong-skill assignment wastes 45+ min.
Reliability (rating + acceptance rate - cancels/no-shows) keeps unreliable
partners off the top slot instead of only gating them at the strike cliff.
=====================================================
*/
function calculatePartnerScore({
  skillMatchLevel,
  distanceMeters,
  partner,
  earningsToday = 1,
  isAC = false,
}) {
  // For partners who have never been assigned, use hours elapsed since workday
  // start today as the idle baseline. Giving them a fixed 24-hour idle score
  // unfairly boosts new or returning partners above those who worked this morning.
  const idleTimeHours = partner.lastAssignedAt
    ? (Date.now() - new Date(partner.lastAssignedAt).getTime()) / (1000 * 60 * 60)
    : (() => {
        const workdayStartToday = new Date();
        workdayStartToday.setHours(WORKDAY_START_HOUR, 0, 0, 0);
        return Math.max((Date.now() - workdayStartToday.getTime()) / (1000 * 60 * 60), 0);
      })();
  const idleScore = Math.min(idleTimeHours / FAIRNESS_LOOKBACK_HOURS, 1) * 100;

  const safeDist = Math.max(distanceMeters, 1); // guard against division by zero/near-zero
  const distanceScore = Math.min((1000 / safeDist) * 100, 100);
  const earningsScore =
    earningsToday > 0 ? Math.min((1000 / earningsToday) * 100, 100) : 100;
  const skillScore = scoreSkillMatch(skillMatchLevel);
  const reliabilityScore = scoreReliability(partner);

  // Weights vary by category (shared with the weight-shadow report).
  const weights = isAC ? AC_SCORE_WEIGHTS : GENERAL_SCORE_WEIGHTS;

  const score =
    idleScore * weights.idle +
    earningsScore * weights.earnings +
    distanceScore * weights.distance +
    skillScore * weights.skill +
    reliabilityScore * weights.reliability;

  return {
    score: Math.round(score * 100) / 100,
    fairnessScore: Math.round(idleScore * 100) / 100,
    distanceScore: Math.round(distanceScore * 100) / 100,
    skillScore: Math.round(skillScore * 100) / 100,
    earningsScore: Math.round(earningsScore * 100) / 100,
    reliabilityScore: Math.round(reliabilityScore * 100) / 100,
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
TEAM ASSIGNMENT PLANNER
Matches ranked partners to the pack's bins so mixed
teams work: technician-tier bins go to technicians,
bridal bins to bridal-capable artists, and everyone
else fills the remaining guest bins.
=====================================================
*/
function partnerFitsBin(entry, bin) {
  if ((bin.tier || 1) >= 2 && Number(entry.partner?.skillTier || 1) < bin.tier) {
    return false;
  }
  if (bin.kind === "BRIDAL" && entry.canBridal === false) return false;
  if (bin.kind === "GUEST" && entry.canGuest === false) return false;
  return true;
}

/**
 * Greedy fill, most-restrictive bins first (bridal, then higher tier, then
 * larger share), best-ranked capable partner each. Returns an ordered plan
 * [{ entry, bin }] — index 0 is the team lead (bridal artist / lead tech) —
 * or null when the pool can't fill every bin. An empty-bins pack (cake,
 * plumbing, …) plans a single partner for the whole job.
 */
function planTeamAssignment(rankedPartners, teamPack) {
  const ranked = Array.isArray(rankedPartners) ? rankedPartners : [];
  const bins = Array.isArray(teamPack?.bins) ? teamPack.bins : [];

  if (!bins.length) {
    return ranked.length
      ? [{ entry: ranked[0], bin: { minutes: 0, tier: 1, kind: "GUEST" } }]
      : null;
  }

  const slots = [...bins].sort((a, b) => {
    if ((a.kind === "BRIDAL") !== (b.kind === "BRIDAL")) {
      return a.kind === "BRIDAL" ? -1 : 1;
    }
    if ((b.tier || 1) !== (a.tier || 1)) return (b.tier || 1) - (a.tier || 1);
    return b.minutes - a.minutes;
  });

  const used = new Set();
  const plan = [];
  for (const bin of slots) {
    const match = ranked.find(
      (entry) =>
        !used.has(String(entry.partner?._id)) && partnerFitsBin(entry, bin)
    );
    if (!match) return null;
    used.add(String(match.partner._id));
    plan.push({ entry: match, bin });
  }
  return plan;
}

/*
=====================================================
CAKE DAILY CAP COUNTING
=====================================================
*/
/**
 * Counts each partner's cake orders (primary OR additional partner) whose
 * scheduledDate falls on the same calendar day. Returns Map<partnerIdString,
 * count>. Category terms come from CAKE_CATEGORY_REGEX so a booking gated as
 * "cake" always also COUNTS as one — the two must never diverge.
 */
async function countCakeOrdersByPartnerForDay(
  partnerIds = [],
  scheduledDate,
  excludeBookingId = null
) {
  if (!partnerIds.length || !scheduledDate) return new Map();
  const { start, end } = getDayBounds(scheduledDate);

  const counts = await Booking.aggregate([
    {
      $match: {
        scheduledDate: { $gte: start, $lt: end },
        status: { $in: CAKE_CAP_COUNT_STATUSES },
        ...(excludeBookingId ? { _id: { $ne: excludeBookingId } } : {}),
        $and: [
          {
            $or: [
              { "services.category": CAKE_CATEGORY_REGEX },
              { serviceCategory: CAKE_CATEGORY_REGEX },
            ],
          },
          {
            $or: [
              { partner: { $in: partnerIds } },
              { additionalPartners: { $in: partnerIds } },
            ],
          },
        ],
      },
    },
    {
      $project: {
        allPartners: {
          $concatArrays: [
            { $cond: [{ $ifNull: ["$partner", false] }, ["$partner"], []] },
            { $ifNull: ["$additionalPartners", []] },
          ],
        },
      },
    },
    { $unwind: "$allPartners" },
    { $group: { _id: "$allPartners", count: { $sum: 1 } } },
  ]);

  return new Map(
    counts.map((row) => [String(row._id), Number(row.count) || 0])
  );
}

/**
 * Post-claim cap re-verification for the assignment engine. The eligibility
 * filter above runs SECONDS before the partner claim (scoring, team sizing,
 * window checks happen in between), so two concurrent cake bookings for the
 * same baker on the same day — at different times, which the busySlots claim
 * guard does not serialize — can both pass it. Re-counting AFTER the claim
 * shrinks that race window to the claim→save gap (milliseconds).
 *
 * Returns the partnerId strings (from `partnerIds`) that are AT or OVER the
 * daily cap; empty array when the booking isn't a cake order.
 */
async function verifyCakeCapAfterClaim(booking, partnerIds = []) {
  if (!booking?.scheduledDate || !partnerIds.length) return [];
  const requestContext = await buildRequestContext({ booking });
  if (!requestContext.isCake) return [];

  const cap = await getCakeDailyCap();
  const countByPartner = await countCakeOrdersByPartnerForDay(
    partnerIds,
    booking.scheduledDate,
    booking?._id
  );
  return partnerIds
    .map(String)
    .filter((id) => (countByPartner.get(id) || 0) >= cap);
}

/*
=====================================================
ELIGIBLE PARTNER FINDER
=====================================================
*/
/**
 * @param {Object} booking
 * @param {string[]} pincodes
 * @param {Object} [opts]
 * @param {boolean} [opts.requireOnline=true] - false for slot-listing/booking-creation
 *   (booking may be hours/days away, partner doesn't need to be online RIGHT NOW);
 *   true for live assignment (we need someone reachable now).
 * @param {ObjectId[]} [opts.precomputedHubIds] - hub mode only: the caller has
 *   already resolved (and territorially gated) the hubs for this search, so the
 *   per-call category + hub resolution here is skipped. Callers that pass this
 *   own the home-hub pause gate.
 */
async function findEligiblePartnersForBooking(booking, pincodes = [], opts = {}) {
  const { requireOnline = true, useH3 = false, precomputedHubIds = null } = opts;
  const requestContext = await buildRequestContext({ booking });
  if (
    !requestContext.requestedServiceIds.length &&
    !requestContext.requestedCategories.length
  ) {
    return [];
  }

  // ── Zone validation ────────────────────────────────────────────────────────
  // Hub path (useH3): validate against Hub; pincode path: validate against Zone.
  let noZoneFallback = false;
  let hubIds = null; // resolved hub _ids when on the Hub path
  if (useH3 && booking?.h3Cell && Array.isArray(precomputedHubIds)) {
    // Caller already resolved + gated the hubs for this search (assignment
    // stage loop, slot listing, capacity scope) — don't re-query per call.
    hubIds = precomputedHubIds;
    if (!hubIds.length) return [];
  } else if (useH3 && booking?.h3Cell) {
    const {
      resolveHubForH3Cell,
      resolveHubsForCells,
      resolveBookingCategories,
    } = require("./zone.service");

    // Hubs are per-category and may overlap the same cells: every hub lookup
    // below is scoped to the booking's own categories so an overlapping hub of
    // a DIFFERENT service can neither block this booking nor lend it partners.
    // Legacy bookings whose category can't be resolved fall back to the old
    // area-level (category-blind) behaviour.
    const bookingCategories = await resolveBookingCategories(booking);
    const categoryIds = bookingCategories.map((c) => c.id);

    // Home-cell pause gate, per category: if the hub that owns this booking's
    // cell is switched off for partner jobs, the booking must not be staffed
    // at all — ring expansion into neighbouring hubs would bypass the pause.
    for (const catId of categoryIds.length ? categoryIds : [null]) {
      const hub = await resolveHubForH3Cell(booking.h3Cell, { categoryId: catId });
      if (hub && hub.partnerAppEnabled === false) {
        console.warn(`[assignment/Hub] Hub "${hub.name}" blocked: partnerAppEnabled=false (booking ${booking?._id})`);
        return [];
      }
    }

    // Stage expansion may legitimately reach neighbouring hubs — resolve all
    // partner-enabled hubs of the booking's categories intersecting the
    // current stage's cells (the cells always include the home cell).
    const stageCells =
      Array.isArray(pincodes) && pincodes.length ? pincodes : [booking.h3Cell];
    hubIds = await resolveHubsForCells(stageCells, {
      categoryIds: categoryIds.length ? categoryIds : null,
      requirePartnerApp: true,
    });
    if (!hubIds.length) {
      console.warn(`[assignment/Hub] No partner-enabled hub of this booking's category covers cell "${booking.h3Cell}" (booking ${booking?._id})`);
      return [];
    }
  } else {
    const zone = await resolveZoneForPincode(booking?.pincode);
    if (!zone) {
      console.warn(
        `[assignment] No zone found for pincode "${booking?.pincode}" (booking ${booking?._id}) — using serviceAreas fallback`
      );
      noZoneFallback = true;
    } else if (
      zone.isActive === false ||
      zone.partnerAppEnabled === false ||
      !isZoneServiceEnabled(zone, requestContext.requestedCategories)
    ) {
      console.warn(
        `[assignment] Zone check blocked assignment for pincode "${booking?.pincode}" (booking ${booking?._id}): isActive=${zone.isActive}, partnerAppEnabled=${zone.partnerAppEnabled}`
      );
      return [];
    }
  }

  const settings = await AdminSetting.findOne().lean();

  const query = {
    isBlocked: false,
    approvalStatus: "APPROVED",
    // Exclude partners under active suspension.
    // $not + $gt matches: null, missing field, or a past date — i.e. not currently suspended.
    // Avoids using $or here because the pincode block below also uses $or.
    suspendedUntil: { $not: { $gt: new Date() } },
    _id: { $nin: booking?.rejectedPartners || [] },
  };

  // ── Territorial filter ─────────────────────────────────────────────────────
  if (useH3) {
    // Hub path: match partners assigned to any hub covering the stage's cells.
    query.assignedHubId = { $in: hubIds || [] };
  } else {
    // No-zone fallback: restrict to partners who registered this pincode as a service area
    if (noZoneFallback && booking?.pincode) {
      query.serviceAreas = booking.pincode;
    }

    // STAGED PINCODE EXPANSION
    if (Array.isArray(pincodes) && pincodes.length) {
      query.$or = [
        { currentPincode: { $in: pincodes } },
        { serviceAreas: { $in: pincodes } },
      ];
    }
  }

  // For live assignment we require partners to be currently online + available.
  // For slot listing / pre-booking checks we DON'T — a partner that took a 1pm
  // job and went offline shouldn't make every other slot of the day vanish for
  // future customers. The window-overlap check below still blocks them from
  // being matched to truly conflicting slots.
  if (requireOnline) {
    query.isOnline = true;
    query.isAvailable = true;
  } else {
    // Even in availability mode, exclude partners who are explicitly unavailable
    // (auto-suspended cancellers). isOnline is allowed to be false because
    // partners may go offline temporarily and come back online before the slot.
    query.isAvailable = { $ne: false };
  }

  if (settings?.partnerVerificationRequired) {
    query.verificationStatus = "VERIFIED";
  }

  // AC: pre-filter at DB level only when EVERY task needs a technician —
  // mixed carts keep tier-1 partners in the pool as team members (the team
  // planner reserves the technician bins for technicians).
  if (requestContext.isAC && requestContext.minRequiredSkillTier >= 2) {
    query.skillTier = { $gte: requestContext.minRequiredSkillTier };
  }

  // Do not apply $near as a hard DB filter here.
  // Partner coordinates may be missing/default [0,0] until the partner app sends
  // live GPS. Zone + service eligibility is the source of truth for slot
  // visibility; valid GPS is used later only for ranking/reachability.

  // .lean(): candidates are read-only here — downstream code only reads fields
  // and claims partners via atomic Partner.findOneAndUpdate by _id, never
  // doc.save(). Skipping full-document hydration cuts the cost of the hottest
  // query in the system (runs per slot-window on every listing, reservation
  // and assignment attempt).
  let partners = await Partner.find(query).lean();
  if (!partners.length) {
    console.warn(
      `[assignment] DB query returned 0 partners for booking ${booking?._id} (pincode: ${booking?.pincode}, requireOnline: ${requireOnline})`
    );
    return [];
  }

  // ── Partner self-declared days off ─────────────────────────────────────────
  // A partner (e.g. a baker) can block whole calendar days via
  // unavailableDates. Applies to any booking, not just cakes — filtered
  // in-memory since the date is stored per-partner without a fixed
  // time-of-day, so a Mongo range match per candidate isn't worth it here.
  if (booking?.scheduledDate) {
    const scheduledKey = normalizeDateKey(booking.scheduledDate);
    const beforeCount = partners.length;
    partners = partners.filter((p) => {
      const blocked = Array.isArray(p.unavailableDates) ? p.unavailableDates : [];
      return !blocked.some((d) => normalizeDateKey(d) === scheduledKey);
    });
    if (!partners.length && beforeCount > 0) {
      console.warn(
        `[assignment] Booking ${booking?._id}: all ${beforeCount} candidate partners have blocked ${scheduledKey}`
      );
      return [];
    }
  }

  // ── Cake daily cap ─────────────────────────────────────────────────────────
  // A baker can hold at most getCakeDailyCap() cake orders per scheduled
  // calendar day. Counted by scheduledDate (not booking creation time) so
  // future-dated orders are capped correctly.
  if (requestContext.isCake && booking?.scheduledDate) {
    const cakeDailyCap = await getCakeDailyCap();
    const countByPartner = await countCakeOrdersByPartnerForDay(
      partners.map((p) => p._id),
      booking.scheduledDate,
      booking?._id
    );

    const before = partners.length;
    partners = partners.filter(
      (p) => (countByPartner.get(String(p._id)) || 0) < cakeDailyCap
    );

    if (!partners.length) {
      console.warn(
        `[assignment/CakeCap] Booking ${booking?._id}: all ${before} candidate bakers already have ${cakeDailyCap} cake orders on ${normalizeDateKey(booking.scheduledDate)}`
      );
      return [];
    }
  }

  const bookingWindow = await getBookingWindow(booking);
  if (
    !isInsideWorkday(
      bookingWindow.scheduledStartAt,
      bookingWindow.scheduledEndAt
    )
  ) {
    console.warn(
      `[assignment] Booking ${booking?._id} window is outside workday: ${bookingWindow.scheduledStartAt}`
    );
    return [];
  }

  const windowsByPartner = await getBlockingWindowsByPartner(
    partners.map((p) => p._id),
    booking.scheduledDate
  );

  let skillBlockCount = 0;
  let windowBlockCount = 0;

  const ranked = partners
    .map((partner) => {
      const skillMatchLevel = getPartnerSkillMatchLevel(
        partner,
        requestContext
      );
      if (!skillMatchLevel) {
        skillBlockCount++;
        return null;
      }

      const partnerWindows =
        windowsByPartner.get(String(partner._id)) || [];
      // RAW service window + booking location: isWindowAvailable enforces a
      // distance-scaled transit gap against each of the partner's existing
      // jobs (flat legacy buffer whenever either address is unusable).
      const candidateWindow = {
        startAt: bookingWindow.scheduledStartAt,
        endAt: bookingWindow.scheduledEndAt,
        location: booking.location || null,
        isAC: requestContext.isAC,
      };

      if (!isWindowAvailable(candidateWindow, partnerWindows)) {
        windowBlockCount++;
        return null;
      }

      // Distance is a ranking signal only — not a hard gate. A partner who
      // declared this pincode (currentPincode / serviceAreas) is eligible
      // regardless of GPS distance; calculatePartnerScore still ranks closer
      // partners higher. Geographic reach is bounded by the zone's
      // nearby/extended pincode config, not by a fixed kilometre cap.
      const LIVE_FRESH_MS = 5 * 60 * 1000; // 5 minutes
      const locationFresh = partner.lastLocationAt &&
        (Date.now() - new Date(partner.lastLocationAt).getTime()) <= LIVE_FRESH_MS;
      // When useLiveLocation is on, online partners without a fresh GPS ping in the
      // last 5 minutes get Infinity distance — they score 0 on distance and are
      // deprioritized vs partners who have sent a recent location update.
      const distanceMeters = (settings?.useLiveLocation && partner.isOnline && !locationFresh)
        ? Infinity
        : calculateDistanceMeters(booking.location, partner.location);

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

      // Which bins this partner may staff — consumed by planTeamAssignment.
      const capabilities = getPartnerTeamCapabilities(partner, requestContext);

      return {
        partner,
        canBridal: capabilities.canBridal,
        canGuest: capabilities.canGuest,
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
        reliabilityScore: scoreBreakdown.reliabilityScore,
      };
    })
    .filter(Boolean)
    .sort(sortRankedPartners);

  if (!ranked.length && partners.length) {
    console.warn(
      `[assignment] Booking ${booking?._id}: ${partners.length} DB candidates all filtered out — skill:${skillBlockCount} window:${windowBlockCount}`
    );
  }

  return ranked;
}

/*
=====================================================
SLOT AVAILABILITY CACHE (PERFORMANCE FIX)
=====================================================
*/
const slotAvailabilityCache = new Map();
const CACHE_TTL_MS = 30 * 1000; // 30 seconds — short enough to reflect new bookings quickly

// Singleton guard: prevent stacking multiple intervals if module is re-required (e.g. in tests)
if (!global.__slotCacheCleanupStarted) {
  global.__slotCacheCleanupStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of slotAvailabilityCache.entries()) {
      if (now - value.timestamp > CACHE_TTL_MS) {
        slotAvailabilityCache.delete(key);
      }
    }
  }, CACHE_TTL_MS).unref(); // unref so it doesn't keep the process alive in tests
}

/*
=====================================================
CACHE INVALIDATION
Call this after any booking is created or cancelled
so the next slot check hits the DB fresh.
=====================================================
*/
function clearSlotCache(pincode, date) {
  const dateKey = normalizeDateKey(date);
  const prefix = `${dateKey}_${pincode}_`;
  for (const key of slotAvailabilityCache.keys()) {
    if (key.startsWith(prefix)) {
      slotAvailabilityCache.delete(key);
    }
  }
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

  // Advance-only orders (cakes): no slots at all for dates inside the lead
  // window. Calendar-day compare — "1 day ahead" allows tomorrow at any hour.
  if (requestContext.minLeadDays > 0) {
    const _now = new Date();
    const earliestAllowed = new Date(
      _now.getFullYear(),
      _now.getMonth(),
      _now.getDate() + requestContext.minLeadDays
    );
    const requested = new Date(date);
    const requestedDay = new Date(
      requested.getFullYear(),
      requested.getMonth(),
      requested.getDate()
    );
    if (requestedDay.getTime() < earliestAllowed.getTime()) {
      return [];
    }
  }

  const durationMinutes = calculateDurationMinutesFromRequest(
    requestContext.requestServices,
    requestContext.serviceMap,
    requestContext.isAC
  );

  const useH3 = await getUseH3Flag();
  // H3 mode: the request's cell + ring-1 search cells are reused by the
  // per-slot partner search below so it stays on the Hub path. Without an
  // h3Cell that search silently falls back to the pincode/Zone path, and a
  // disabled zone would hide every slot even though the hub is active.
  let requestH3Cell = null;
  let h3SearchCells = [];
  let h3HubIds = null; // resolved once here; per-slot searches reuse it
  if (useH3) {
    // H3 mode: validate against the hub(s) covering the booking location — one
    // per service category, since hubs are per-service and may overlap. Showing
    // bookable slots for a service the area's hub doesn't cover would fail later
    // at the createBooking gate, so we apply the same per-service check here.
    const coords = Array.isArray(location?.coordinates) ? location.coordinates : null;
    const hasGps = coords && coords.length === 2 &&
      Number.isFinite(Number(coords[0])) && Number.isFinite(Number(coords[1])) &&
      (Number(coords[0]) !== 0 || Number(coords[1]) !== 0);

    const { resolveHubForLocation, resolveBookingCategories } = require("./zone.service");

    let gateLat = null;
    let gateLng = null;
    let ringFallback = false;
    if (hasGps) {
      gateLat = Number(coords[1]);
      gateLng = Number(coords[0]);
      requestH3Cell = deriveH3Cell(gateLat, gateLng);
    } else if (pincode) {
      const { forwardGeocode } = require("./geocode.service");
      const geo = await forwardGeocode(pincode);
      if (geo.ok) {
        gateLat = geo.lat;
        gateLng = geo.lng;
        ringFallback = true;
        requestH3Cell = deriveH3Cell(gateLat, gateLng);
      }
    }

    if (gateLat === null || !requestH3Cell) {
      return [];
    }

    // Every service category in the request must have an active, app-enabled hub here.
    const neededCategories = await resolveBookingCategories({ services, serviceId, serviceCategory });
    const gateCategories = neededCategories.length ? neededCategories : [{ id: null }];
    for (const cat of gateCategories) {
      const hub = await resolveHubForLocation(gateLat, gateLng, { ringFallback, categoryId: cat.id });
      if (
        !hub ||
        hub.isActive === false ||
        hub.customerAppEnabled === false ||
        hub.partnerAppEnabled === false
      ) {
        return [];
      }
    }

    // Ring-1 cells absorb pincode-centroid fuzz (same k as the hub gate's
    // ringFallback above) and match the assignment engine's stage-2 reach.
    h3SearchCells = getH3Ring(requestH3Cell, 1);

    // Resolve the partner pool's hubs ONCE for the whole request — scoped to
    // the request's categories and to partner-enabled hubs — instead of
    // re-resolving inside every per-slot search. The per-category gate above
    // already enforced the home hub's pause flags.
    const { resolveHubsForCells } = require("./zone.service");
    const gateCategoryIds = neededCategories.map((c) => c.id).filter(Boolean);
    h3HubIds = await resolveHubsForCells(h3SearchCells, {
      categoryIds: gateCategoryIds.length ? gateCategoryIds : null,
      requirePartnerApp: true,
    });
    if (!h3HubIds.length) {
      return [];
    }
  } else {
    const zone = await resolveZoneForPincode(pincode);
    if (
      !zone ||
      zone.isActive === false ||
      zone.customerAppEnabled === false ||
      zone.partnerAppEnabled === false ||
      !isZoneServiceEnabled(zone, requestContext.requestedCategories)
    ) {
      return [];
    }
  }

  // --- PERFORMANCE FIX: CACHING ---
  // Round location to 2 decimal places (~1.1km precision) to group nearby users
  let locKey = "none";
  if (Array.isArray(location?.coordinates) && location.coordinates.length === 2) {
    locKey = `${Number(location.coordinates[0]).toFixed(2)},${Number(location.coordinates[1]).toFixed(2)}`;
  }
  // requestedCategories is included alongside requestedServiceIds: a legacy
  // category-only request (no resolvable service ids) previously collapsed to
  // an identical key for every category at a given date/pincode/duration —
  // two different categories with the same duration shared one cached
  // availability result. Sorted + joined so key order can't cause a miss.
  const cacheKey = `${normalizeDateKey(date)}_${pincode}_${locKey}_${requestContext.requestedServiceIds.join(",")}_${[...requestContext.requestedCategories].sort().join(",")}_${durationMinutes}`;
  
  const cached = slotAvailabilityCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return cached.data;
  }
  // --------------------------------

  const now = new Date();
  const isToday = normalizeDateKey(date) === normalizeDateKey(now);
  const { getSlotAvailabilitySnapshot } = require("./slotCapacity.service");

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

    const rankedPartners = await findEligiblePartnersForBooking(
      {
        scheduledDate: date,
        scheduledTime: getTimeLabel(slotStart),
        pincode,
        location,
        h3Cell: requestH3Cell,
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
      h3SearchCells,
      // Slot listing — partner may come online later. Hub mode reuses the
      // request-level hub set resolved above (precomputedHubIds).
      { requireOnline: false, useH3, precomputedHubIds: h3HubIds }
    );

    if (!rankedPartners.length) continue;

    // Capability feasibility: the pool must be able to fill EVERY bin (enough
    // bridal-capable artists / technician-tier techs), not just reach the
    // headcount — a slot the assignment engine can't actually staff must not
    // be shown as bookable.
    if (!planTeamAssignment(rankedPartners, requestContext.teamPack)) continue;

    const snapshot = await getSlotAvailabilitySnapshot(
      {
        services: requestContext.requestServices.map((item) => ({
          serviceId: item.serviceId,
          quantity: item.quantity || 1,
          category: item.category,
          subCategory: item.subCategory,
        })),
        serviceId,
        serviceCategory,
        scheduledDate: date,
        scheduledTime: getTimeLabel(slotStart),
        scheduledStartAt: slotStart,
        scheduledEndAt: slotEnd,
        estimatedDurationMinutes: durationMinutes,
        location,
        pincode,
        h3Cell: requestH3Cell,
        rejectedPartners: [],
      },
      slotStart,
      slotEnd,
      null,
      // Listing must never write — this path is reachable without auth.
      { readOnly: true }
    );

    if (snapshot.availableUnits < snapshot.requiredCount) continue;

    slotResults.push({
      time: getTimeLabel(slotStart),
      durationMinutes,
      availablePartners: snapshot.availableUnits,
      bestPartnerDistanceMeters: Number.isFinite(
        rankedPartners[0].distanceMeters
      )
        ? Math.round(rankedPartners[0].distanceMeters)
        : null,
      isAC: requestContext.isAC,
    });
  }

  // --- PERFORMANCE FIX: CACHING ---
  slotAvailabilityCache.set(cacheKey, {
    timestamp: Date.now(),
    data: slotResults,
  });
  // --------------------------------

  return slotResults;
}

module.exports = {
  // Constants (exported for use in assignmentEngine.js)
  AC_CATEGORY_SLUGS,
  AC_MAX_CAPACITY_MINUTES,
  AC_TRAVEL_BUFFER_MINUTES,
  AC_VISIT_WINDOW_MINUTES,
  MEHENDI_VISIT_WINDOW_MINUTES,
  AC_ADDITIONAL_UNIT_FACTOR,
  BRIDAL_ARTISTS_PER_BRIDE,
  BLOCKING_BOOKING_STATUSES,
  SLOT_HOLDING_BOOKING_STATUSES,
  DEFAULT_SERVICE_DURATION_MINUTES,
  DEFAULT_TRAVEL_BUFFER_MINUTES,
  SLOT_GAP_MINUTES,
  WORKDAY_END_HOUR,
  WORKDAY_START_HOUR,
  // Learned-parameter constants (used by the nightly learning crons)
  AC_SCORE_WEIGHTS,
  GENERAL_SCORE_WEIGHTS,
  LEARNED_DURATION_MIN_FACTOR,
  LEARNED_DURATION_MAX_FACTOR,
  LEARNED_DURATION_MIN_SAMPLES,
  TRAVEL_BUFFER_GENERAL_MIN,
  TRAVEL_BUFFER_GENERAL_MAX,
  TRAVEL_BUFFER_AC_MIN,
  TRAVEL_BUFFER_AC_MAX,
  scoreReliability,
  // Utilities
  addMinutes,
  buildDateTime,
  normalizeDateKey,
  // Core functions
  clearSlotCache,
  findEligiblePartnersForBooking,
  getAvailableSlotsForRequest,
  getBookingWindow,
  getBlockingWindowsByPartner,
  syncPartnerOperationalState,
  isACCategory,
  getCakeDailyCap,
  countCakeOrdersByPartnerForDay,
  verifyCakeCapAfterClaim,
  // Team packing / planning
  packTeamTasks,
  computeTeamPackForBooking,
  planTeamAssignment,
  partnerFitsBin,
  calculateDurationForServices,
  calculateDurationMinutesFromRequest,
  // Transit buffers
  travelBufferMinutesForDistance,
  isWindowAvailable,
};
