const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");
const mongoose = require("mongoose");
const Category = require("../models/Category");
const { creditWallet, debitWallet } = require("./partnerWallet.controller");
const { getAvailableSlots } = require("../services/slotAvailability_service");
const { assignBooking, reassignBooking } = require("../services/assignmentEngine");
const { deriveH3Cell } = require("../utils/h3");
const { fileToPublicUrl } = require("../utils/fileUrl");
const { forwardGeocode } = require("../services/geocode.service");
const {
  getZoneServiceKeysFromValues,
  isZoneServiceEnabled,
  resolveZoneForPincode,
  resolveHubForLocation,
  resolveBookingCategories,
} = require("../services/zone.service");
const { getUseH3Flag } = require("../services/assignmentEngine");
const {
  buildDateTime,
  clearSlotCache,
  syncPartnerOperationalState,
  AC_MAX_CAPACITY_MINUTES,
  AC_CATEGORY_SLUGS,
} = require("../services/scheduling_service");
const {
  calculatePricing,
  getPricingSettings,
  getMehendiPricingRuleKey,
  getMehendiHandsPrice,
  validateCakeOptions,
  computeCakeLineTotal,
  hasCustomization,
} = require("../utils/pricing");
const { validateCouponForAmount } = require("../services/coupon.service");
const {
  SLOT_LOCK_MINUTES,
  markSlotLockPaid,
  releaseSlotCapacityByBookingId,
  reserveSlotCapacityForBooking,
} = require("../services/slotCapacity.service");
const {
  sendJobCancelledPush,
  notifyCustomerOfBookingStatus,
} = require("../services/pushNotification.service");

const PAYMENT_LOCK_MINUTES = SLOT_LOCK_MINUTES;

const AdminSetting = require("../admin/models/AdminSetting");

// Admin flag: job-spot selfie verification (60s cache, same pattern as useH3Zones)
let _jobSelfieFlagCache = { value: false, expiresAt: 0 };
async function getJobSelfieFlag() {
  if (Date.now() < _jobSelfieFlagCache.expiresAt) return _jobSelfieFlagCache.value;
  try {
    const s = await AdminSetting.findOne().select("jobSelfieVerificationEnabled").lean();
    _jobSelfieFlagCache = {
      value: Boolean(s?.jobSelfieVerificationEnabled),
      expiresAt: Date.now() + 60_000,
    };
  } catch {
    _jobSelfieFlagCache.expiresAt = Date.now() + 10_000;
  }
  return _jobSelfieFlagCache.value;
}

// Admin-configurable flat penalty (₹) charged when a partner cancels after
// arriving. Cached 60s; falls back to the default if settings are unreachable.
// Live value lives in AdminSetting.cancellation.arrivedCancelPenaltyInr.
const DEFAULT_ARRIVED_CANCEL_PENALTY_INR = 100;
let _arrivedCancelPenaltyCache = { value: DEFAULT_ARRIVED_CANCEL_PENALTY_INR, expiresAt: 0 };
async function getArrivedCancelPenalty() {
  if (Date.now() < _arrivedCancelPenaltyCache.expiresAt) return _arrivedCancelPenaltyCache.value;
  try {
    const s = await AdminSetting.findOne().select("cancellation.arrivedCancelPenaltyInr").lean();
    const raw = s?.cancellation?.arrivedCancelPenaltyInr;
    _arrivedCancelPenaltyCache = {
      value: Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : DEFAULT_ARRIVED_CANCEL_PENALTY_INR,
      expiresAt: Date.now() + 60_000,
    };
  } catch {
    _arrivedCancelPenaltyCache.expiresAt = Date.now() + 10_000;
  }
  return _arrivedCancelPenaltyCache.value;
}

const normalizeText = (value = "") =>
  String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const roundAmount = (value) =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const clampPercent = (value, fallback = 20) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, 0), 100);
};

const calculatePartnerSettlement = async (booking, partner) => {
  const taxableAmount = Math.max(
    roundAmount(Number(booking.baseAmount || 0) - Number(booking.discountAmount || 0)),
    0
  );

  const bookingLines = Array.isArray(booking.services) ? booking.services : [];

  if (bookingLines.length) {
    const lineTotalBase = bookingLines.reduce(
      (sum, item) => sum + Number(item.lineTotal || 0),
      0
    );
    const discountFactor =
      lineTotalBase > 0 ? taxableAmount / lineTotalBase : 1;

    const validIds = bookingLines
      .map((item) => String(item.serviceId || ""))
      .filter((id) => mongoose.Types.ObjectId.isValid(id));

    const serviceRows = await Service.find({ _id: { $in: validIds } })
      .select("commissionPercent")
      .lean();
    const serviceMap = new Map(serviceRows.map((row) => [String(row._id), row]));

    let commissionAmount = 0;

    for (const item of bookingLines) {
      const lineTotal = roundAmount(Number(item.lineTotal || 0) * discountFactor);
      const commissionPercent = clampPercent(
        serviceMap.get(String(item.serviceId || ""))?.commissionPercent,
        clampPercent(partner?.commissionPercent, 20)
      );
      commissionAmount += roundAmount((lineTotal * commissionPercent) / 100);
    }

    commissionAmount = Math.min(roundAmount(commissionAmount), taxableAmount);

    return {
      grossAmount: taxableAmount,
      commissionAmount,
      partnerEarningAmount: roundAmount(taxableAmount - commissionAmount),
    };
  }

  let commissionPercent = clampPercent(partner?.commissionPercent, 20);
  if (booking.serviceId && mongoose.Types.ObjectId.isValid(String(booking.serviceId))) {
    const service = await Service.findById(booking.serviceId)
      .select("commissionPercent")
      .lean();
    commissionPercent = clampPercent(service?.commissionPercent, commissionPercent);
  }

  const commissionAmount = roundAmount((taxableAmount * commissionPercent) / 100);
  return {
    grossAmount: taxableAmount,
    commissionAmount,
    partnerEarningAmount: roundAmount(taxableAmount - commissionAmount),
  };
};

/* =======================
   USER CREATES BOOKING
======================= */
exports.createBooking = async (req, res) => {
  try {
    const AdminSetting = require("../admin/models/AdminSetting");
    const settings = await AdminSetting.findOne().lean();
    if (settings?.emergencyLockdown || settings?.bookingsDisabled) {
      return res.status(503).json({
        success: false,
        message: settings?.emergencyLockdown
          ? "Service temporarily unavailable. Please try again later."
          : "New bookings are temporarily disabled. Please try again later.",
      });
    }

    const {
      services, // NEW (array)
      primaryService, // NEW
      serviceCategory, // (fallback for old flow)
      serviceId, // (fallback for old flow)
      scheduledDate,
      scheduledTime,
      location,
      pincode,
      address,
      houseDetails,
      landmark,
      couponCode,
    } = req.body;

    if (!pincode) {
      return res.status(400).json({ success: false, message: "pincode is required" });
    }

    if (!scheduledDate || !scheduledTime) {
      return res.status(400).json({ success: false, message: "scheduledDate and scheduledTime are required" });
    }

    // Validate that the date + time form a real future slot before any DB work.
    let _slotCheck;
    try {
      _slotCheck = buildDateTime(scheduledDate, scheduledTime);
    } catch (dtErr) {
      return res.status(400).json({ success: false, message: dtErr.message });
    }
    if (_slotCheck.getTime() < Date.now() - 5 * 60 * 1000) {
      return res.status(400).json({ success: false, message: "Cannot book a slot that is already in the past" });
    }

    // When H3 mode resolves coordinates from a pincode (no client GPS), we reuse
    // them for the booking's stored location + h3Cell so assignment routes correctly.
    let effectiveCoords = null; // [lng, lat]
    // Resolved only in pincode/zone mode (useH3 === false). Stays null in hub
    // mode; the zone-service check below is skipped when it is null.
    let zone = null;

    const useH3 = await getUseH3Flag();
    if (useH3) {
      const coords = location?.coordinates;
      const hasClientGps =
        Array.isArray(coords) &&
        coords.length === 2 &&
        Number.isFinite(Number(coords[0])) &&
        Number.isFinite(Number(coords[1])) &&
        (Number(coords[0]) !== 0 || Number(coords[1]) !== 0);

      let lat;
      let lng;
      let ringFallback = false;
      if (hasClientGps) {
        // Precise GPS — strict exact-cell gate.
        lng = Number(coords[0]);
        lat = Number(coords[1]);
      } else {
        // No GPS (e.g. web pincode-only) — geocode the pincode to a centroid and
        // use the lenient ring gate to absorb pincode-boundary fuzz.
        const geo = await forwardGeocode(pincode, "booking_pincode_fallback");
        if (geo.ok) {
          lat = geo.lat;
          lng = geo.lng;
          ringFallback = true;
        }
      }

      // Per-service gate: every service category in the booking must have an
      // active hub covering this spot. Hubs are per-service and can overlap, so
      // an area served for one service is not automatically served for another.
      const neededCategories = await resolveBookingCategories(req.body);
      const gateCategories = neededCategories.length
        ? neededCategories
        : [{ id: null, name: "Service" }];

      const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
      for (const cat of gateCategories) {
        const hub = hasCoords
          ? await resolveHubForLocation(lat, lng, { ringFallback, categoryId: cat.id })
          : null;

        if (!hub || hub.isActive === false) {
          return res.status(403).json({
            success: false,
            message: cat.id
              ? `${cat.name} is not available in this area`
              : "Service not available in this area",
          });
        }
        if (hub.customerAppEnabled === false) {
          return res.status(403).json({
            success: false,
            message: "Bookings are currently paused for this area",
          });
        }
        if (hub.partnerAppEnabled === false) {
          return res.status(403).json({
            success: false,
            message: cat.id
              ? `${cat.name} is currently unavailable in this area`
              : "Service is currently unavailable in this area",
          });
        }
      }

      if (hasCoords) {
        effectiveCoords = [lng, lat];
      }
    } else {
      zone = await resolveZoneForPincode(pincode);
      if (!zone || zone.isActive === false) {
        return res.status(403).json({
          success: false,
          message: "Service not available in this pincode",
        });
      }
      if (zone.customerAppEnabled === false) {
        return res.status(403).json({
          success: false,
          message: "Bookings are currently paused for this pincode",
        });
      }
      if (zone.partnerAppEnabled === false) {
        return res.status(403).json({
          success: false,
          message: "Service is currently unavailable in this pincode",
        });
      }
    }

    let bookingServices = [];
    let baseAmount = 0;
    let finalPrimaryService = primaryService;
    const categorySlugCache = new Map();
    let totalDurationMinutes = 0;
    const allServiceCancellationTiers = [];
    // Customization-configured (cake) services drive lead-time and the
    // SINCE_BOOKING cancellation policy for the whole booking.
    let hasCustomizedService = false;
    let hasPlainService = false;
    let maxMinLeadDays = 0;
    let sinceBookingPolicy = null; // { tiers } from the first SINCE_BOOKING service
    const mehendiRestrictedFeetOnly = new Set(["feet", "basic feet", "ankle", "above ankle"]);
    const mehendiAllFeetOptions = new Set([
      "feet",
      "basic feet",
      "ankle",
      "above ankle",
      "mid leg",
      "below knee",
    ]);

    const resolveServiceCategorySlug = async (service) => {
      const legacyCategory = String(service?.legacyCategory || "").toLowerCase().trim();
      if (legacyCategory) {
        return legacyCategory;
      }

      const categoryId = String(service?.category || "").trim();
      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return "";
      }

      if (categorySlugCache.has(categoryId)) {
        return categorySlugCache.get(categoryId);
      }

      const category = await Category.findById(categoryId).select("slug name").lean();
      const resolved = String(category?.slug || category?.name || "")
        .toLowerCase()
        .trim();
      categorySlugCache.set(categoryId, resolved);
      return resolved;
    };

    /* =====================
       NEW MULTI-SERVICE FLOW
    ===================== */
    if (services && services.length > 0) {
      const Service = require("../models/service.model");

      for (const item of services) {
        const incomingServiceId = String(item?.serviceId || "");

        if (!mongoose.Types.ObjectId.isValid(incomingServiceId)) {
          return res.status(400).json({
            success: false,
            message: `Invalid serviceId: ${incomingServiceId}`,
          });
        }

        const service = await Service.findById(incomingServiceId);

        if (!service) {
          return res.status(404).json({
            success: false,
            message: `Service not found: ${incomingServiceId}`,
          });
        }

        const categorySlug = await resolveServiceCategorySlug(service);
        const quantity = Math.max(Number(item.quantity || 1), 1);
        // Pricing is ALWAYS taken from the server-side Service record. The
        // client-supplied price is never trusted — a tampered request could
        // otherwise set an arbitrary amount. A service with no valid configured
        // price is rejected outright rather than falling back to client input.
        const price = Number(service.price || 0);
        const durationMinutes = Math.max(
          Number(service.duration || 0) || 0,
          1
        );

        if (price <= 0) {
          return res.status(400).json({
            success: false,
            message: `Invalid price configured for service: ${service._id}`,
          });
        }

        // Customized services (cakes): options are validated against the
        // Service's admin-managed customization config and priced entirely
        // server-side — flavour/tier/addon deltas come from the DB record.
        let resolvedOptions = null;
        let customizedTotals = null;
        if (hasCustomization(service)) {
          const validation = validateCakeOptions(service, item.options || {});
          if (!validation.ok) {
            return res.status(400).json({
              success: false,
              message: validation.message,
            });
          }
          resolvedOptions = validation.options;
          customizedTotals = computeCakeLineTotal(service, resolvedOptions, quantity);

          hasCustomizedService = true;
          maxMinLeadDays = Math.max(maxMinLeadDays, Number(service.minLeadDays) || 0);
          if (
            service.cancellationPolicyType === "SINCE_BOOKING" &&
            !sinceBookingPolicy &&
            Array.isArray(service.sinceBookingTiers) &&
            service.sinceBookingTiers.length > 0
          ) {
            sinceBookingPolicy = { tiers: service.sinceBookingTiers };
          }
        } else {
          hasPlainService = true;
        }

        // Mehendi hand designs use tiered "package" pricing by number of hands
        // (e.g. 2 hands of Minimal Mehendi = ₹699, not 2 × ₹399 = ₹798). The
        // per-hand base price stays in `price`; only the line total is tiered.
        // Everything else falls back to plain price × quantity.
        const mehendiPricingRuleKey = getMehendiPricingRuleKey(service.name);
        const mehendiPackageTotal = mehendiPricingRuleKey
          ? getMehendiHandsPrice(mehendiPricingRuleKey, quantity)
          : null;
        const itemTotal = customizedTotals
          ? customizedTotals.lineTotal
          : mehendiPackageTotal != null
            ? mehendiPackageTotal
            : price * quantity;
        const categoryValue =
          categorySlug || (service.category ? String(service.category) : "");
        const subCategoryValue = service.subCategory
          ? String(service.subCategory)
          : "";

        baseAmount += itemTotal;
        totalDurationMinutes += durationMinutes * quantity;

        bookingServices.push({
          serviceId: service._id,
          name: service.name,
          price: customizedTotals ? customizedTotals.unitPrice : price,
          lineTotal: itemTotal,
          quantity,
          category: categoryValue,
          subCategory: subCategoryValue,
          ...(resolvedOptions ? { options: resolvedOptions } : {}),
        });

        // Collect cancellation tiers from each service for snapshot
        if (Array.isArray(service.cancellationTiers) && service.cancellationTiers.length > 0) {
          allServiceCancellationTiers.push(service.cancellationTiers);
        }
      }

      // Customized (cake) orders can't be mixed with other services in one
      // booking — lead time, cancellation policy, and baker capacity would
      // become ambiguous for the combined cart.
      if (hasCustomizedService && hasPlainService) {
        return res.status(400).json({
          success: false,
          message: "Cake orders must be booked separately from other services",
        });
      }

      // if primary service not provided → take first service
      if (!finalPrimaryService) {
        finalPrimaryService = bookingServices[0].serviceId;
      }

      const normalizedMehendiNames = bookingServices
        .filter((item) => String(item.category || "").toLowerCase().includes("mehendi"))
        .map((item) => String(item.name || "").toLowerCase().trim());

      const hasRestrictedFeetOnly = normalizedMehendiNames.some((name) =>
        mehendiRestrictedFeetOnly.has(name)
      );
      const hasHandDesign = normalizedMehendiNames.some((name) => {
        if (name === "mehendi for guests") return false;
        if (mehendiAllFeetOptions.has(name)) return false;
        return true;
      });
      const hasBridalDesign = normalizedMehendiNames.some((name) =>
        name.includes("bridal mehendi")
      );

      if (hasRestrictedFeetOnly && !hasHandDesign) {
        return res.status(400).json({
          success: false,
          message:
            "Basic Feet, Ankle, and Above Ankle add-ons require a Mehendi hand design. Mid Leg and Below Knee can be booked separately.",
        });
      }

      if (hasHandDesign || hasBridalDesign) {
        baseAmount = 0;
        bookingServices = bookingServices.map((item) => {
          const normalizedItemName = normalizeText(item.name);
          if (
            hasBridalDesign &&
            (normalizedItemName === "basic feet" || normalizedItemName === "feet")
          ) {
            return {
              ...item,
              lineTotal: 0,
            };
          }
          const isDiscountedLegAddon =
            normalizedItemName === "mid leg" || normalizedItemName === "below knee";
          if (!isDiscountedLegAddon) {
            baseAmount += Number(item.lineTotal || 0);
            return item;
          }

          const discountedLineTotal = Math.round(
            Number(item.price || 0) * Math.max(Number(item.quantity || 1), 1) * 0.66
          );

          baseAmount += discountedLineTotal;
          return {
            ...item,
            lineTotal: discountedLineTotal,
          };
        });
      }

    }

    /* =====================
       OLD SINGLE SERVICE FLOW
       (BACKWARD COMPATIBILITY)
    ===================== */
    else if (serviceId) {
      if (!mongoose.Types.ObjectId.isValid(String(serviceId))) {
        return res.status(400).json({
          success: false,
          message: "Invalid serviceId",
        });
      }

      // Fetch the service so the zone-service validation below has its
      // category/name to inspect. Without this, legacy single-service bookings
      // bypass the zone-service-enablement check entirely.
      const Service = require("../models/service.model");
      const legacyService = await Service.findById(serviceId).lean();
      if (!legacyService) {
        return res.status(404).json({
          success: false,
          message: `Service not found: ${serviceId}`,
        });
      }

      // Customized services (cakes) need an options payload the legacy
      // single-service format can't carry — require the multi-service flow.
      if (hasCustomization(legacyService)) {
        return res.status(400).json({
          success: false,
          message: "This service requires customization options. Please update your app to book it.",
        });
      }

      const legacyCategorySlug = await resolveServiceCategorySlug(legacyService);

      // Pricing is ALWAYS taken from the server-side Service record — same
      // rule as the multi-service flow. This path previously hardcoded ₹500,
      // which let a replayed legacy-format request book ANY service at a flat
      // ₹500 regardless of its real price.
      const legacyPrice = Number(legacyService.price || 0);
      if (legacyPrice <= 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid price configured for service: ${legacyService._id}`,
        });
      }
      const legacyDuration =
        Number(legacyService.duration) > 0 ? Number(legacyService.duration) : 60;

      bookingServices.push({
        serviceId: legacyService._id,
        name: legacyService.name,
        price: legacyPrice,
        lineTotal: legacyPrice,
        quantity: 1,
        category:
          legacyCategorySlug ||
          (legacyService.category ? String(legacyService.category) : ""),
        subCategory: legacyService.subCategory
          ? String(legacyService.subCategory)
          : "",
      });

      baseAmount = legacyPrice;
      finalPrimaryService = serviceId;
      totalDurationMinutes = legacyDuration;

      // Same cancellation-tier snapshot rule as the multi-service flow.
      if (
        Array.isArray(legacyService.cancellationTiers) &&
        legacyService.cancellationTiers.length > 0
      ) {
        allServiceCancellationTiers.push(legacyService.cancellationTiers);
      }
    }

    else {
      return res.status(400).json({
        success: false,
        message: "Services or serviceId is required",
      });
    }

    const zoneServiceKeys = getZoneServiceKeysFromValues([
      serviceCategory,
      ...bookingServices.map((item) => item.category),
      ...bookingServices.map((item) => item.name),
    ]);

    // Only enforced in pincode/zone mode. In hub mode zone is null and the hub's
    // own availability was already checked above, so skip this gate.
    if (zone && !isZoneServiceEnabled(zone, zoneServiceKeys)) {
      return res.status(403).json({
        success: false,
        message: "Selected service is not enabled in this pincode",
      });
    }

    // Advance-only orders (cakes): the scheduled date must be at least
    // minLeadDays calendar days ahead of today (local server time — same
    // semantics as buildDateTime/normalizeDateKey). "1 day ahead" means
    // tomorrow is fine at any hour; today is never allowed.
    if (maxMinLeadDays > 0) {
      const now = new Date();
      const earliestAllowed = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + maxMinLeadDays
      );
      const sched = new Date(scheduledDate);
      const scheduledDay = new Date(
        sched.getFullYear(),
        sched.getMonth(),
        sched.getDate()
      );
      if (scheduledDay.getTime() < earliestAllowed.getTime()) {
        return res.status(400).json({
          success: false,
          message:
            maxMinLeadDays === 1
              ? "Cake orders must be placed at least 1 day in advance. Please pick tomorrow or later."
              : `This order must be placed at least ${maxMinLeadDays} days in advance.`,
        });
      }
    }

      /* =====================
         COUPON LOGIC
      ===================== */
      let discountAmount = 0;
      let appliedCoupon = null;

      const couponCodeClean = String(couponCode || "").trim();
      if (couponCodeClean) {
        const couponResult = await validateCouponForAmount({
          code: couponCodeClean,
          amount: baseAmount,
          customerId: req.user?._id || null,
          serviceIds: bookingServices.map((s) => String(s.serviceId)),
        });

        discountAmount = couponResult.discount;
        appliedCoupon = couponResult.coupon;
      }

      /* =====================
         PRICE CALCULATION
      ===================== */
      const pricingSettings = await getPricingSettings();
      const pricing = calculatePricing({
      baseAmount,
      discount: discountAmount,
      pricing: pricingSettings,
    });

    const scheduledStartAt = buildDateTime(scheduledDate, scheduledTime);

    // Use the AC capacity ceiling for air-conditioning jobs; 240 min for everything else.
    const allCategories = [
      serviceCategory,
      ...bookingServices.map((s) => s.category),
      ...bookingServices.map((s) => s.name),
    ].map((v) => String(v || "").toLowerCase());
    const isAC = AC_CATEGORY_SLUGS.some((slug) =>
      allCategories.some((c) => c.includes(slug))
    );
    const maxDurationMinutes = isAC ? AC_MAX_CAPACITY_MINUTES : 240;
    const estimatedDurationMinutes = Math.min(
      Math.max(totalDurationMinutes || 60, 1),
      maxDurationMinutes
    );

    const scheduledEndAt = new Date(
      scheduledStartAt.getTime() + estimatedDurationMinutes * 60 * 1000
    );

    /* =====================
       CREATE BOOKING + RESERVE SLOT CAPACITY
       The reservation is written before payment starts so two customers cannot
       both pay for the same limited slot.
    ===================== */
    // Compute cancellation tiers snapshot — most lenient refundPercent at each threshold
    // across all booked services. Falls back to [] (global defaults apply at cancel time).
    const cancellationTiersSnapshot = mergeCancellationTiers(allServiceCancellationTiers);

    const bookingPayload = {
      user: req.user._id,
      services: bookingServices,
      primaryService: finalPrimaryService,
      serviceCategory:
        typeof serviceCategory === "string" && serviceCategory.trim()
          ? serviceCategory.trim()
          : bookingServices[0]?.category || "general",
      serviceId: serviceId ?? finalPrimaryService ?? null,
      pincode,
      h3Cell: (() => {
        const coords = effectiveCoords || location?.coordinates;
        if (Array.isArray(coords) && coords.length === 2) {
          return deriveH3Cell(coords[1], coords[0]); // GeoJSON is [lng, lat]
        }
        return null;
      })(),
      address: String(address || "").trim(),
      houseDetails: houseDetails ? String(houseDetails).trim() : null,
      landmark: landmark ? String(landmark).trim() : null,
      couponCode: appliedCoupon ? appliedCoupon.code : null,
      couponId: appliedCoupon ? appliedCoupon._id : null,
      couponDiscountAmount: discountAmount,
      baseAmount: pricing.baseAmount,
      discountAmount: pricing.discountAmount,
      platformFeeAmount: pricing.platformFeeAmount,
      gstAmount: pricing.gstAmount,
      totalAmount: pricing.totalAmount,
      scheduledDate: new Date(scheduledDate),
      scheduledTime,
      scheduledStartAt,
      scheduledEndAt,
      estimatedDurationMinutes,
      // Use the pincode-geocoded coords when the client sent none, so the stored
      // location matches the h3Cell used for assignment.
      location: effectiveCoords
        ? { type: "Point", coordinates: effectiveCoords }
        : location,
      lockedUntil: new Date(Date.now() + PAYMENT_LOCK_MINUTES * 60 * 1000),
      lockedCapacityMinutes: estimatedDurationMinutes,
      payment: { status: "PENDING" },
      status: "PENDING_PAYMENT",
      cancellationTiersSnapshot,
      cancellationPolicyTypeSnapshot: sinceBookingPolicy ? "SINCE_BOOKING" : "BEFORE_SERVICE",
      sinceBookingTiersSnapshot: sinceBookingPolicy
        ? sinceBookingPolicy.tiers.map((t) => ({
            maxHoursAfterBooking: Number(t.maxHoursAfterBooking),
            refundPercent: Number(t.refundPercent),
          }))
        : [],
    };

    const session = await mongoose.startSession();
    let booking = null;

    try {
      await session.withTransaction(async () => {
        const [createdBooking] = await Booking.create([bookingPayload], { session });
        booking = createdBooking;

        const reservation = await reserveSlotCapacityForBooking(booking, { session });
        booking.slotLockId = reservation.lock._id;
        booking.slotReservationUnits = reservation.requiredCount;
        booking.slotReservationExpiresAt = reservation.expiresAt;
        booking.lockedUntil = reservation.expiresAt;
        booking.lockedCapacityMinutes = estimatedDurationMinutes;
      });
    } catch (reserveError) {
      const code = reserveError?.statusCode || 500;
      if (code === 409) {
        return res.status(409).json({
          success: false,
          message: reserveError.message || "Selected slot is no longer available",
        });
      }

      console.error("Booking reservation error:", reserveError);
      return res.status(code).json({
        success: false,
        message: reserveError.message || "Booking creation failed",
      });
    } finally {
      await session.endSession();
    }

    // Bust the slot cache for this pincode+date so any other customer
    // immediately sees the updated availability without waiting for TTL.
    clearSlotCache(pincode, scheduledDate);

    return res.status(201).json({
      success: true,
      message: "Booking created. Proceed to payment.",
      booking,
    });
  } catch (error) {
    console.error("Create booking error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Booking creation failed",
    });
  }
};
/* =======================
   PAYMENT VERIFIED → AUTO ASSIGN PARTNER
======================= */
exports.afterPaymentSuccess = async (req, res) => {
  try {
    const { bookingId } = req.params;

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    booking.payment.status = "PAID";
    booking.lockedUntil = null; // Convert lock to permanent capacity
    booking.slotReservationExpiresAt = null;
    await markSlotLockPaid(booking._id);

    const scheduledStart = booking.scheduledStartAt 
      ? new Date(booking.scheduledStartAt) 
      : buildDateTime(booking.scheduledDate, booking.scheduledTime);

    // Always try instant assignment. If no partner is found right now, assignBooking
    // falls back to QUEUED (via queueOnFailure) so the cron retries automatically.
    booking.status = "SEARCHING";
    await booking.save();

    if (global.io) {
      global.io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: booking._id.toString(),
        status: "SEARCHING",
        paymentConfirmed: true,
      });
    }

    await assignBooking(booking._id, { queueOnFailure: true });

    res.json({
      success: true,
      message: "Payment verified. Searching for partner.",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* =======================
   GET AVAILABLE SLOTS
======================= */
exports.getAvailableSlots = async (req, res) => {
  try {
    const input = req.method === "POST" ? req.body || {} : req.query || {};
    const date = input.date;
    const serviceCategory = input.serviceCategory;
    const serviceId = input.serviceId;
    const services = Array.isArray(input.services) ? input.services : [];
    const pincode = input.pincode;
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);

    if (!date || (!serviceCategory && !serviceId && !services.length)) {
      return res.status(400).json({
        message: "date and serviceId, services, or serviceCategory are required",
      });
    }

    const slots = await getAvailableSlots(date, serviceId, serviceCategory, {
      services,
      pincode,
      location:
        Number.isFinite(latitude) && Number.isFinite(longitude)
          ? {
              type: "Point",
              coordinates: [longitude, latitude],
            }
          : null,
    });

    res.json({
      success: true,
      date,
      slots,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* =======================
   PARTNER STARTS TRAVEL
   Guards: must be assigned partner; status must be PARTNER_ACCEPTED or CONFIRMED.
   Side effects:
     - estimates ETA from partner location → customer location
     - notifies user via socket
======================= */
exports.markOnTheWay = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const partnerId = req.partner?._id;
    if (!partnerId) return res.status(401).json({ message: "Partner auth required" });

    const booking = await Booking.findById(bookingId).populate(
      "partner",
      "location"
    );
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    // Authorization: must be assigned to this booking
    const pid = String(partnerId);
    const isAssigned =
      booking.partner?._id?.toString() === pid ||
      (booking.additionalPartners || []).some((p) => p.toString() === pid);
    if (!isAssigned) {
      return res.status(403).json({ message: "Not assigned to this booking" });
    }

    // Status guard
    if (!["PARTNER_ACCEPTED", "CONFIRMED"].includes(booking.status)) {
      return res.status(400).json({
        message: `Cannot mark on-the-way from status ${booking.status}`,
      });
    }

    // ETA — naive haversine + 3 min/km (Indian traffic baseline)
    let etaMinutes = null;
    let estimatedArrivalAt = null;
    try {
      const partnerCoords = booking.partner?.location?.coordinates;
      const customerCoords = booking.location?.coordinates;
      if (
        Array.isArray(partnerCoords) &&
        Array.isArray(customerCoords) &&
        partnerCoords.length === 2 &&
        customerCoords.length === 2
      ) {
        const [pLng, pLat] = partnerCoords.map(Number);
        const [cLng, cLat] = customerCoords.map(Number);
        const toRad = (v) => (v * Math.PI) / 180;
        const R = 6371;
        const dLat = toRad(cLat - pLat);
        const dLng = toRad(cLng - pLng);
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(pLat)) *
            Math.cos(toRad(cLat)) *
            Math.sin(dLng / 2) ** 2;
        const km = 2 * R * Math.asin(Math.sqrt(a));
        etaMinutes = Math.max(5, Math.round(km * 3));
        estimatedArrivalAt = new Date(Date.now() + etaMinutes * 60 * 1000);
      }
    } catch (e) {
      // ETA is best-effort; partner can still proceed without it
    }

    booking.status = "ON_THE_WAY";
    booking.estimatedArrivalAt = estimatedArrivalAt;
    await booking.save();

    // Notify user with ETA only.
    if (global.io) {
      global.io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: booking._id.toString(),
        status: "ON_THE_WAY",
        etaMinutes,
        estimatedArrivalAt,
      });
    }

    notifyCustomerOfBookingStatus(booking.user, "ON_THE_WAY", booking._id);

    res.json({
      success: true,
      message: "Partner marked on the way",
      etaMinutes,
      estimatedArrivalAt,
    });
  } catch (err) {
    console.error("markOnTheWay error:", err);
    res.status(500).json({ message: "Failed to update status" });
  }
};

/* =======================
   PARTNER ARRIVED
   Optional intermediate state — useful for SLA tracking.
======================= */
exports.markArrived = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const partnerId = req.partner?._id;
    if (!partnerId) return res.status(401).json({ message: "Partner auth required" });

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const pid = String(partnerId);
    const isAssigned =
      booking.partner?.toString() === pid ||
      (booking.additionalPartners || []).some((p) => p.toString() === pid);
    if (!isAssigned) {
      return res.status(403).json({ message: "Not assigned to this booking" });
    }

    if (booking.status !== "ON_THE_WAY") {
      return res.status(400).json({
        message: `Cannot mark arrived from status ${booking.status}`,
      });
    }

    const arrivedAt = new Date();
    const updated = await Booking.findOneAndUpdate(
      { _id: bookingId, status: "ON_THE_WAY" },
      { $set: { status: "ARRIVED", arrivedAt } },
      { new: true }
    );

    if (!updated) {
      return res.status(409).json({ message: "Booking status changed concurrently — please refresh" });
    }

    if (global.io) {
      global.io.to(`user_${updated.user}`).emit("booking_update", {
        bookingId: updated._id.toString(),
        status: "ARRIVED",
        arrivedAt,
      });
    }

    notifyCustomerOfBookingStatus(updated.user, "ARRIVED", updated._id);

    res.json({ success: true, message: "Arrival recorded" });
  } catch (err) {
    console.error("markArrived error:", err);
    res.status(500).json({ message: "Failed to update status" });
  }
};

/* =======================
   PARTNER REPORTS AN ON-SITE ISSUE
   e.g. "customer not available" / "asked me to come later".
   Deliberately minimal: records an audit entry + pings ops. It does NOT
   change booking status, apply fees, or issue refunds — a human decides.
   This exists to (a) give partners a way to flag the problem instead of
   silently cancelling, and (b) measure how often it happens before we
   invest in an automated fee/reschedule rule.
======================= */
const PARTNER_REPORT_ISSUE_TYPES = [
  "CUSTOMER_NOT_AVAILABLE",
  "CUSTOMER_ASKED_LATER",
  "CUSTOMER_NOT_REACHABLE",
  "WRONG_ADDRESS",
  "OTHER",
];

// Subset that means "the customer is the reason the job can't proceed". For
// these, both apps surface a cancel button: customer cancels → no refund;
// partner cancels → penalty. The booking is NOT auto-cancelled.
const CUSTOMER_FAULT_ISSUE_TYPES = ["CUSTOMER_NOT_AVAILABLE", "CUSTOMER_ASKED_LATER"];

// Partner fields a customer is allowed to see on their own booking. Includes the
// onboarding selfie so the customer knows who is coming (and can match the face
// at the door). Shared like name/phone/rating — not gated behind the job-selfie
// verification feature flag.
const CUSTOMER_PARTNER_FIELDS = "name phone rating selfieUrl selfieVerificationStatus";

// Only expose the selfie to the customer once the admin has verified it — they
// should never match against an unverified/rejected photo. Mutates the lean
// partner object in place (blanks the URL; keeps the status for the UI badge).
function gateSelfieForCustomer(p) {
  if (p && String(p.selfieVerificationStatus || "").toUpperCase() !== "APPROVED") {
    p.selfieUrl = "";
  }
  return p;
}

function gateBookingSelfies(booking) {
  if (!booking) return booking;
  if (booking.partner) gateSelfieForCustomer(booking.partner);
  if (Array.isArray(booking.additionalPartners)) {
    booking.additionalPartners.forEach(gateSelfieForCustomer);
  }
  return booking;
}

exports.reportBookingIssue = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const partnerId = req.partner?._id;
    if (!partnerId) return res.status(401).json({ message: "Partner auth required" });

    const issueType = String(req.body?.issueType || "OTHER").toUpperCase();
    const note = String(req.body?.note || "").trim().slice(0, 500);
    if (!PARTNER_REPORT_ISSUE_TYPES.includes(issueType)) {
      return res.status(400).json({ message: "Invalid issue type" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    // Only the assigned partner (or a helper) may report on this booking.
    const pid = String(partnerId);
    const isAssigned =
      booking.partner?.toString() === pid ||
      (booking.additionalPartners || []).some((p) => p.toString() === pid);
    if (!isAssigned) {
      return res.status(403).json({ message: "Not assigned to this booking" });
    }

    const report = {
      partner: partnerId,
      issueType,
      note,
      statusAtReport: booking.status,
      createdAt: new Date(),
    };

    booking.partnerReports = booking.partnerReports || [];
    booking.partnerReports.push(report);
    await booking.save();

    console.warn(
      `[partner-report] Booking ${bookingId} flagged by partner ${pid} — issue=${issueType}, status=${booking.status}, note="${note}"`
    );

    // Ping the ops room so support can follow up — same channel as escalations.
    if (global.io) {
      global.io.to("admin_ops").emit("partner_booking_report", {
        bookingId: String(bookingId),
        partnerId: pid,
        issueType,
        note,
        statusAtReport: booking.status,
        pincode: booking.pincode || "",
        timestamp: report.createdAt.toISOString(),
      });
    }

    // For CUSTOMER_NOT_AVAILABLE / CUSTOMER_ASKED_LATER: notify the customer
    // so the cancel button appears in their app. No status change here — the
    // customer cancels (no refund) or the partner cancels (penalty applies).
    if (CUSTOMER_FAULT_ISSUE_TYPES.includes(issueType)) {
      if (global.io) {
        global.io.to(`user_${booking.user}`).emit("booking_update", {
          bookingId: String(booking._id),
          status: booking.status,
          partnerReportedIssue: issueType,
        });
      }
    }

    return res.json({
      success: true,
      message: "Reported to support. Our team will reach out shortly.",
    });
  } catch (err) {
    console.error("reportBookingIssue error:", err);
    return res.status(500).json({ message: "Failed to report issue" });
  }
};

// Selfies taken further than this from the booking location get flagged
// for admin review (GPS drift indoors is typically well under 100m).
const SELFIE_FLAG_DISTANCE_METERS = 300;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* =======================
   PARTNER UPLOADS ON-SITE SELFIE
   Live selfie taken at the customer's location (front camera, no gallery).
   Required before startService when jobSelfieVerificationEnabled is on.
   GPS sent with the upload is compared against the booking location;
   far-away selfies are flagged for admin review (never blocked).
======================= */
exports.uploadStartSelfie = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const partnerId = req.partner?._id;
    if (!partnerId) return res.status(401).json({ message: "Partner auth required" });

    if (!req.file) {
      return res.status(400).json({ success: false, message: "Selfie image is required" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const pid = String(partnerId);
    const isAssigned =
      booking.partner?.toString() === pid ||
      (booking.additionalPartners || []).some((p) => p.toString() === pid);
    if (!isAssigned) {
      return res.status(403).json({ message: "Not assigned to this booking" });
    }

    if (!["ON_THE_WAY", "ARRIVED"].includes(booking.status)) {
      return res.status(400).json({
        message: `Cannot upload selfie from status ${booking.status}`,
      });
    }

    // Public URL of the uploaded selfie (R2 / Cloudinary / local — see utils/fileUrl).
    const selfieUrl = fileToPublicUrl(req, req.file);

    // GPS tie-in: multer parses multipart text fields into req.body.
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    const hasGps =
      Number.isFinite(latitude) && Number.isFinite(longitude) &&
      (latitude !== 0 || longitude !== 0);

    let distanceMeters = null;
    let flagged = false;
    const bCoords = booking.location?.coordinates;
    if (hasGps && Array.isArray(bCoords) && bCoords.length === 2) {
      const bLng = Number(bCoords[0]);
      const bLat = Number(bCoords[1]);
      if (Number.isFinite(bLat) && Number.isFinite(bLng) && (bLat !== 0 || bLng !== 0)) {
        distanceMeters = Math.round(haversineMeters(latitude, longitude, bLat, bLng));
        flagged = distanceMeters > SELFIE_FLAG_DISTANCE_METERS;
      }
    }

    booking.startSelfieUrl = selfieUrl;
    booking.startSelfieAt = new Date();
    booking.startSelfieLocation = {
      latitude: hasGps ? latitude : null,
      longitude: hasGps ? longitude : null,
    };
    booking.startSelfieDistanceMeters = distanceMeters;
    booking.startSelfieFlagged = flagged;
    await booking.save();

    return res.json({ success: true, message: "Selfie uploaded" });
  } catch (err) {
    console.error("uploadStartSelfie error:", err);
    return res.status(500).json({ success: false, message: "Failed to upload selfie" });
  }
};

/* =======================
   PARTNER STARTS SERVICE
   Gated by the in-app service start code: the customer reads the 4-digit
   code from their booking screen to the partner. No SMS involved.
======================= */
exports.startService = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const partnerId = req.partner?._id;

    if (!partnerId) return res.status(401).json({ message: "Partner auth required" });

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const pid = String(partnerId);
    const isAssigned =
      booking.partner?.toString() === pid ||
      (booking.additionalPartners || []).some((p) => p.toString() === pid);
    if (!isAssigned) {
      return res.status(403).json({ message: "Not assigned to this booking" });
    }

    if (!["ON_THE_WAY", "ARRIVED"].includes(booking.status)) {
      return res.status(400).json({
        message: `Cannot start service from status ${booking.status}`,
      });
    }

    // Job-spot selfie gate (admin-controlled): the partner must have uploaded
    // their on-site selfie via /start-selfie before the start code is accepted.
    if (!booking.startSelfieUrl && (await getJobSelfieFlag())) {
      return res.status(400).json({
        code: "START_SELFIE_REQUIRED",
        message: "Please take your on-site selfie before starting the service.",
      });
    }

    // Verify the start code. Bookings created before this feature have no
    // code stored — they start without one (legacy fallback).
    if (booking.serviceStartCode) {
      const attempts = Number(booking.startCodeAttempts || 0);
      if (attempts >= 5) {
        return res.status(429).json({
          code: "START_CODE_LOCKED",
          message: "Too many wrong code attempts. Please contact support.",
        });
      }

      const submitted = String(req.body?.startCode || "").trim();
      if (!submitted) {
        return res.status(400).json({
          code: "START_CODE_REQUIRED",
          message: "Ask the customer for the start code shown in their app.",
        });
      }
      if (submitted !== booking.serviceStartCode) {
        await Booking.updateOne(
          { _id: booking._id },
          { $inc: { startCodeAttempts: 1 } }
        );
        const remaining = 4 - attempts;
        return res.status(400).json({
          code: "START_CODE_INVALID",
          message: `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`,
        });
      }
    }

    // ATOMIC UPDATE: Prevent race conditions
    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: bookingId, status: booking.status },
      {
        $set: {
          status: "IN_PROGRESS",
        }
      },
      { new: true }
    );

    if (!updatedBooking) {
      return res.status(409).json({ message: "Booking state changed. Please refresh." });
    }

    if (global.io) {
      global.io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: booking._id.toString(),
        status: "IN_PROGRESS",
      });
    }

    res.json({ success: true, message: "Service started" });
  } catch (err) {
    console.error("startService error:", err);
    res.status(500).json({ message: "Failed to start service" });
  }
};

/* =======================
   PARTNER COMPLETES BOOKING
======================= */
exports.completeBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    // Only use the authenticated partner identity — never trust req.body.partnerId
    const partnerId = req.partner?._id;
    if (!partnerId) return res.status(401).json({ message: "Partner auth required" });

    const booking = await Booking.findById(bookingId).populate("partner");

    if (!booking) return res.status(404).json({ message: "Booking not found" });

    // Idempotency — partner taps "Complete" twice on flaky network.
    if (booking.status === "COMPLETED") {
      return res.json({
        success: true,
        alreadyCompleted: true,
        message: "Booking already completed",
        settlement: booking.partnerSettlement,
      });
    }

    if (booking.status !== "IN_PROGRESS") {
      return res.status(400).json({ message: "Booking not in progress" });
    }

    // Authorization — only an assigned partner can complete
    const pid = String(partnerId);
    const isAssigned =
      booking.partner?._id?.toString() === pid ||
      (booking.additionalPartners || []).some((p) => p.toString() === pid);
    if (!isAssigned) {
      return res.status(403).json({ message: "Not assigned to this booking" });
    }

    const partner = booking.partner;
    const settlement = await calculatePartnerSettlement(booking, partner);

    const teamAllocations = booking.get("teamAllocations") || [];
    const additionalPartners = booking.additionalPartners || [];

    let currentPartnerShare = 0;

    // --- INDIVIDUAL PAYOUT & COMPLETION ---
    if (partnerId && teamAllocations.length > 0) {
      const allocation = teamAllocations.find(a => a.partnerId?.toString() === partnerId.toString());

      // If we have team allocations but this partner isn't in them, the booking
      // data is inconsistent — fail loudly instead of silently paying ₹0.
      if (!allocation) {
        console.error(
          `[completeBooking] Partner ${partnerId} authorized on booking ${bookingId} but missing from teamAllocations`
        );
        return res.status(409).json({
          success: false,
          message: "Your allocation on this booking is missing. Please contact support.",
        });
      }

      {
        if (allocation.status === "COMPLETED") {
          return res.status(400).json({ success: false, message: "You have already completed your part." });
        }

        // CREDIT BEFORE MARKING COMPLETE (crash safety). creditWallet is
        // idempotent per { partner, booking } via the unique job_payment
        // ledger index, so a concurrent double-tap can only ever write one
        // credit. Crediting first means a crash between the two steps leaves
        // the allocation un-completed — the partner's retry re-runs
        // creditWallet (no-op) and then marks the allocation. The old order
        // (mark COMPLETED first, credit second) permanently lost the
        // partner's share if the process died in between: the COMPLETED
        // allocation blocked the retry and no cron reconciled it.
        currentPartnerShare = roundAmount(settlement.partnerEarningAmount * allocation.payoutRatio);
        await creditWallet({
          partnerId: partnerId,
          amount: currentPartnerShare,
          reason: "job_payment",
          bookingId: booking._id,
          description: `Earning from booking #${booking._id} (Pending 48h Settlement)`,
          bucket: "pending",
        });

        // ATOMIC ARRAY UPDATE: the $elemMatch guard requires this partner's
        // allocation to be not-yet-COMPLETED. Two concurrent completeBooking
        // calls from the same partner therefore can't both pass — only the
        // first flips the element and proceeds. The loser 409s, but the
        // wallet stays correct because the credit above is idempotent.
        const arrayUpdate = await Booking.findOneAndUpdate(
          {
            _id: bookingId,
            teamAllocations: { $elemMatch: { partnerId, status: { $ne: "COMPLETED" } } },
          },
          { $set: { "teamAllocations.$.status": "COMPLETED", "teamAllocations.$.completedAt": new Date() } },
          { new: true }
        );

        if (!arrayUpdate) {
          return res.status(409).json({ success: false, message: "Booking state changed. Please refresh." });
        }


        // Free their individual calendar
        await syncPartnerOperationalState(partnerId);

        const pendingPartners = arrayUpdate.teamAllocations.filter(a => a.status !== "COMPLETED");
        if (pendingPartners.length > 0) {
          return res.json({
            success: true,
            message: `Your task is complete! ₹${currentPartnerShare} credited to your wallet. Waiting for teammates.`,
            earning: currentPartnerShare
          });
        }
      }
    }

    // --- FALLBACK (OLD BOOKINGS WITHOUT TEAM ALLOCATIONS) ---
    if (teamAllocations.length === 0) {
      // ATOMIC UPDATE FIRST: Prevent paying out for a booking the user just cancelled.
      // If this findOneAndUpdate returns null, the user beat us — return 409 without crediting wallets.
      const updatedBooking = await Booking.findOneAndUpdate(
        { _id: bookingId, status: "IN_PROGRESS" },
        {
          $set: {
            status: "COMPLETED",
            completedAt: new Date(),
            isPaidToPartner: false,
            requiresRating: true,
            // "pending" until all wallet credits confirm — cron retries if process crashes here
            payoutStatus: "pending",
            partnerSettlement: {
              grossAmount: settlement.grossAmount,
              commissionAmount: settlement.commissionAmount,
              partnerEarningAmount: settlement.partnerEarningAmount,
              status: "UNSETTLED",
              settledAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
              paidOutAt: null,
            },
          },
        },
        { new: true }
      );

      if (!updatedBooking) {
        return res.status(409).json({ message: "Booking state changed during completion. Please refresh." });
      }

      if (!booking.partner) {
        console.error(`[completeBooking] Booking ${bookingId} has no partner reference — skipping wallet credit`);
        return res.status(500).json({ message: "Partner reference missing on booking" });
      }

      const totalPartnersCount = 1 + additionalPartners.length;
      const fallbackSplitAmount = roundAmount(settlement.partnerEarningAmount / totalPartnersCount);

      if (additionalPartners.length > 0) {
        let totalDistributedToGuests = 0;
        for (const additionalPartnerId of additionalPartners) {
          totalDistributedToGuests += fallbackSplitAmount;
          await creditWallet({
            partnerId: additionalPartnerId,
            amount: fallbackSplitAmount,
            reason: "job_payment",
            bookingId: booking._id,
            description: `Earning from booking #${booking._id} (Pending 48h Settlement)`,
            bucket: "pending",
          });
          await syncPartnerOperationalState(additionalPartnerId);
        }
        currentPartnerShare = roundAmount(settlement.partnerEarningAmount - totalDistributedToGuests);
      } else {
        currentPartnerShare = settlement.partnerEarningAmount;
      }

      await creditWallet({
        partnerId: booking.partner._id,
        amount: currentPartnerShare,
        reason: "job_payment",
        bookingId: booking._id,
        description: `Earning from booking #${booking._id} (Pending 48h Settlement)`,
        bucket: "pending",
      });
      await syncPartnerOperationalState(booking.partner._id);

      /* =====================
         PROCESS REFERRAL REWARD
      ===================== */
      const { processReferralReward } = require("../utils/referral");
      await processReferralReward(booking.user, booking._id);

      // All credits succeeded — mark so the retry cron skips this booking
      await Booking.findByIdAndUpdate(bookingId, { $set: { payoutStatus: "credited" } });

      if (global.io) {
        global.io.to(`user_${booking.user}`).emit("jobCompleted", {
          bookingId: booking._id,
          message: "Your service has been completed",
        });
      }

      notifyCustomerOfBookingStatus(booking.user, "COMPLETED", booking._id);

      return res.json({
        success: true,
        message: `Booking completed! ₹${currentPartnerShare} credited to your wallet.`,
        settlement,
      });
    }

    // ATOMIC UPDATE for team-allocation path (all partners already paid individually above)
    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: bookingId, status: "IN_PROGRESS" },
      {
        $set: {
          status: "COMPLETED",
          completedAt: new Date(),
          isPaidToPartner: false,
          requiresRating: true,
          // Individual credits already completed above — mark as credited immediately
          payoutStatus: "credited",
          partnerSettlement: {
            grossAmount: settlement.grossAmount,
            commissionAmount: settlement.commissionAmount,
            partnerEarningAmount: settlement.partnerEarningAmount,
            status: "UNSETTLED",
            settledAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
            paidOutAt: null,
          },
        },
      },
      { new: true }
    );

    if (!updatedBooking) {
      return res.status(409).json({ message: "Booking state changed during completion. Please refresh." });
    }

    // Team-allocation path: referral + notify after all partners complete
    const { processReferralReward } = require("../utils/referral");
    await processReferralReward(booking.user, booking._id);

    if (global.io) {
      global.io.to(`user_${booking.user}`).emit("jobCompleted", {
        bookingId: booking._id,
        message: "Your service has been completed",
      });
    }

    notifyCustomerOfBookingStatus(booking.user, "COMPLETED", booking._id);

    res.json({
      success: true,
      message: `Booking fully completed by your team! Your share of ₹${currentPartnerShare} was credited to your wallet.`,
      settlement,
    });
  } catch (error) {
    console.error("completeBooking error:", { bookingId: req.params?.bookingId, err: error.message });
    res.status(500).json({ message: error.message });
  }
};

/* =======================
   PARTNER CANCELS BOOKING
   (MAX 5 PER ROLLING WEEK + AUTO-SUSPEND AT LIMIT)
   Special case: cancelling from ARRIVED status closes the booking entirely
   (no reassignment) and charges a penalty — partner arrived but walked away.
======================= */
const PARTNER_WEEKLY_CANCEL_LIMIT = 5;
const PARTNER_DAILY_CANCEL_LIMIT  = 1;

const PARTNER_CANCEL_REASONS = [
  "Emergency / personal issue",
  "Vehicle breakdown",
  "Customer not reachable",
  "Location too far",
  "Job scope changed",
  "Health issue",
];

exports.cancelBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { reason } = req.body || {};

    if (!reason || !PARTNER_CANCEL_REASONS.includes(reason)) {
      return res.status(400).json({
        message: "A valid cancellation reason is required.",
        validReasons: PARTNER_CANCEL_REASONS,
      });
    }

    const booking = await Booking.findById(bookingId);
    const partner = await Partner.findById(req.partner._id);

    if (!booking || !partner)
      return res.status(404).json({ message: "Booking not found" });

    const isPrimary = booking.partner && booking.partner.toString() === partner._id.toString();
    const additionalPartners = booking.get("additionalPartners") || [];
    const isAdditional = additionalPartners.some(id => id.toString() === partner._id.toString());

    if (!isPrimary && !isAdditional) {
      return res.status(403).json({ message: "Unauthorized cancellation" });
    }

    const now = new Date();

    /* =====================
       CANCEL STRIKES & RATE LIMITS — voluntary (non-ARRIVED) cancels only.

       An ARRIVED cancel is a "customer refused / asked later" situation: it is
       governed by the wallet penalty instead, so it must NOT consume the daily
       quota, count toward weekly auto-suspension, or block a partner who is
       stuck at a refusing customer's door (#5 — no double penalty).

       For voluntary cancels we CHECK the limits up front (reject if over) but only
       COMMIT the strike via commitCancelStrike() after the booking actually
       transitions, so a lost race (the 409 paths below) never penalises the
       partner for a cancellation that didn't happen (#4 — no charge on race).
    ===================== */
    const isArrivedCancel = booking.status === "ARRIVED";
    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // Default no-op (ARRIVED path); redefined below for voluntary cancels.
    let commitCancelStrike = async () => {};

    if (!isArrivedCancel) {
      // ----- DAILY CANCEL LIMIT (1 per calendar day) — check only -----
      const sameDay = partner.lastDailyCancelDate === todayStr;
      if (sameDay && partner.dailyCancelCount >= PARTNER_DAILY_CANCEL_LIMIT) {
        return res.status(400).json({
          message: `You can only cancel ${PARTNER_DAILY_CANCEL_LIMIT} job per day. Try again tomorrow.`,
        });
      }

      // ----- ROLLING 7-DAY WINDOW (auto-suspension) — check only -----
      // Use epoch (0) as the safe default so a null lastCancelReset always triggers a reset,
      // rather than comparing against NaN (which is what `new Date(null)` produces in some runtimes).
      const lastReset = partner.lastCancelReset ? new Date(partner.lastCancelReset) : new Date(0);
      const diffDays = (now.getTime() - lastReset.getTime()) / (1000 * 60 * 60 * 24);
      const willResetWeek = diffDays >= 7;
      const effectiveWeekly = willResetWeek ? 0 : (partner.weeklyCancelCount || 0);

      if (effectiveWeekly >= PARTNER_WEEKLY_CANCEL_LIMIT) {
        return res.status(400).json({
          message: `Weekly cancel limit reached (${PARTNER_WEEKLY_CANCEL_LIMIT} per week). Account suspended.`,
        });
      }

      // Persist the strike + free load — only invoked after a successful transition.
      // Uses a single atomic pipeline update (not read-modify-write) so two concurrent
      // cancels by the same partner can't clobber each other's counter increments and
      // dodge the daily/weekly limit or the weekly auto-suspension. The day/week reset is
      // recomputed from the stored fields inside the update so it's race-safe.
      commitCancelStrike = async () => {
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        const weeklyResetCond = {
          $gte: [
            { $subtract: [now, { $ifNull: ["$lastCancelReset", new Date(0)] }] },
            weekMs,
          ],
        };
        const updated = await Partner.findOneAndUpdate(
          { _id: partner._id },
          [
            {
              $set: {
                dailyCancelCount: {
                  $cond: [
                    { $eq: ["$lastDailyCancelDate", todayStr] },
                    { $add: [{ $ifNull: ["$dailyCancelCount", 0] }, 1] },
                    1,
                  ],
                },
                lastDailyCancelDate: todayStr,
                weeklyCancelCount: {
                  $add: [
                    { $cond: [weeklyResetCond, 0, { $ifNull: ["$weeklyCancelCount", 0] }] },
                    1,
                  ],
                },
                lastCancelReset: {
                  $cond: [weeklyResetCond, now, { $ifNull: ["$lastCancelReset", now] }],
                },
              },
            },
            {
              $set: {
                isBlocked: {
                  $cond: [
                    { $gte: ["$weeklyCancelCount", PARTNER_WEEKLY_CANCEL_LIMIT] },
                    true,
                    "$isBlocked",
                  ],
                },
              },
            },
          ],
          { new: true }
        );

        if (updated) {
          // Mirror the committed values onto the in-memory doc for the response below.
          partner.weeklyCancelCount = updated.weeklyCancelCount;
          partner.dailyCancelCount = updated.dailyCancelCount;
          partner.isBlocked = updated.isBlocked;
          if (updated.weeklyCancelCount >= PARTNER_WEEKLY_CANCEL_LIMIT) {
            console.warn(`[AUTO-SUSPEND] Partner ${partner._id} (${partner.name}) suspended after ${updated.weeklyCancelCount} weekly cancellations`);
          }
        }

        await syncPartnerOperationalState(partner._id);
      };
    }

    /* =====================
       ARRIVED → CANCEL OUTRIGHT + PENALTY
       Partner arrived but walked away (customer refused or asked later).
       No reassignment — the customer caused the situation, so the booking
       is closed. Customer gets 0% refund; partner pays a penalty.
    ===================== */
    if (booking.status === "ARRIVED") {
      const cancelledBooking = await Booking.findOneAndUpdate(
        { _id: booking._id, status: "ARRIVED" },
        {
          $set: {
            status: "CANCELLED",
            cancelledBy: "partner",
            cancelledAt: now,
            cancelReason: reason,
            refundAmount: 0,
            refundStatus: "NONE",
          },
          $push: { partnerCancellations: { partner: partner._id, reason, cancelledAt: now } },
        },
        { new: true }
      );

      if (!cancelledBooking) {
        return res.status(409).json({
          success: false,
          message: "Booking state changed during cancellation — please refresh",
        });
      }

      await releaseSlotCapacityByBookingId(booking._id, { releaseReason: "partner_arrived_cancel" });
      await syncPartnerOperationalState(partner._id);
      clearSlotCache(booking.pincode, booking.scheduledDate);

      // Notify customer — booking closed, no refund
      if (global.io) {
        global.io.to(`user_${cancelledBooking.user}`).emit("booking_update", {
          bookingId: cancelledBooking._id.toString(),
          status: "CANCELLED",
          cancelledBy: "partner",
          refundAmount: 0,
        });
      }

      // Admin-configured penalty (₹). If set to 0, skip the wallet debit.
      const penaltyInr = await getArrivedCancelPenalty();
      // Track the actual outcome so the partner app can show truthful feedback
      // (how much was charged now vs recorded as owed).
      let penaltyCollected = penaltyInr;
      let penaltyOutstanding = 0;
      if (penaltyInr > 0) {
        // allowShortfall: a penalty must never be silently lost. It collects what the
        // balance allows and records any uncollected remainder as a PENDING (owed)
        // ledger row, so the debt is durable and recoverable — not just a log line.
        try {
          const debitResult = await debitWallet({
            partnerId: partner._id,
            amount: penaltyInr,
            reason: "penalty",
            bookingId: booking._id,
            description: `Penalty: cancelled after arriving at customer location — Booking ${booking._id}`,
            allowShortfall: true,
          });
          penaltyCollected = debitResult.collected;
          penaltyOutstanding = debitResult.shortfall;
          if (debitResult.shortfall > 0) {
            console.warn(
              `[arrived-cancel] Partner ${partner._id} penalty ₹${penaltyInr}: ₹${debitResult.collected} collected, ₹${debitResult.shortfall} OUTSTANDING (pending debit recorded). Booking ${booking._id}.`
            );
            if (global.io) {
              global.io.to("admin_ops").emit("partner_penalty_outstanding", {
                partnerId: String(partner._id),
                bookingId: String(booking._id),
                penalty: penaltyInr,
                collected: debitResult.collected,
                outstanding: debitResult.shortfall,
                reason: "arrived_cancel_penalty",
                timestamp: new Date().toISOString(),
              });
            }
          }
        } catch (penaltyErr) {
          // Hard failure (DB error, etc.) — nothing collected; alert ops so the penalty
          // is still recoverable manually rather than lost to a console line.
          penaltyCollected = 0;
          penaltyOutstanding = penaltyInr;
          console.error(
            `[arrived-cancel] Penalty debit FAILED for partner ${partner._id}, Booking ${booking._id}: ${penaltyErr.message}`
          );
          if (global.io) {
            global.io.to("admin_ops").emit("partner_penalty_failed", {
              partnerId: String(partner._id),
              bookingId: String(booking._id),
              penalty: penaltyInr,
              error: penaltyErr.message,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      console.warn(
        `[arrived-cancel] Partner ${partner._id} cancelled after arriving — Booking ${booking._id} closed, ₹${penaltyInr} penalty attempted.`
      );

      return res.json({
        success: true,
        message: penaltyInr > 0
          ? "Booking cancelled. A penalty has been applied to your account."
          : "Booking cancelled.",
        weeklyCancelCount: partner.weeklyCancelCount,
        penalty: penaltyInr,
        penaltyCollected,
        penaltyOutstanding,
      });
    }

    /* =====================
       ALL OTHER STATUSES → REASSIGN AS BEFORE
    ===================== */

    // Atomically release the booking before kicking off reassignment.
    // Without this, if reassignBooking later throws inside its internal
    // try/catch, the booking stays pointed at this partner forever (zombie
    // state). With it, the booking is at minimum left in SEARCHING for a
    // retry/admin recovery, even if reassignment fails.
    const releasedBooking = await Booking.findOneAndUpdate(
      {
        _id: booking._id,
        status: { $in: ["ASSIGNED", "CONFIRMED", "PARTNER_ACCEPTED", "ON_THE_WAY"] },
      },
      {
        // autoRefundIfUnassigned: this is a partner cancellation — if reassignment
        // later exhausts, escalation should auto-cancel + refund (not park it on ops).
        $set:  { status: "SEARCHING", partner: null, autoRefundIfUnassigned: true },
        $push: { partnerCancellations: { partner: partner._id, reason, cancelledAt: now } },
      },
      { new: true }
    );

    if (!releasedBooking) {
      return res.status(409).json({
        success: false,
        message: "Booking state changed during cancellation — please refresh",
      });
    }

    // Booking actually transitioned — now (and only now) commit the cancel strike,
    // so a lost race above never penalises the partner.
    await commitCancelStrike();

    // Tell the customer immediately so their BookingStatusScreen flips back
    // to "Searching for Partner" instead of staying on the cancelled assignment.
    if (global.io) {
      global.io.to(`user_${releasedBooking.user}`).emit("booking_update", {
        bookingId: releasedBooking._id.toString(),
        status: "SEARCHING",
      });
    }

    // Bust slot cache so the freed slot is visible to other customers
    // immediately (without waiting for the 30s TTL).
    clearSlotCache(booking.pincode, booking.scheduledDate);

    /* =====================
       REASSIGN BOOKING
       skipPartnerPenalty: we already incremented weeklyCancelCount above.
       Without the flag, reassignBooking would double-count this strike.
    ===================== */
    await reassignBooking(booking._id, partner._id, { skipPartnerPenalty: true });

    res.json({
      success: true,
      message: "Booking cancelled and reassigned",
      weeklyCancelCount: partner.weeklyCancelCount,
    });
  } catch (error) {
    console.error("Cancel error:", error);
    res.status(500).json({ message: "Cancellation failed" });
  }
};

/* =======================
   USER CANCELS BOOKING
======================= */
/*
 * USER CANCELS BOOKING — refund tiers based on time-to-service.
 *   > 24 h before  → 100% refund
 *   4 – 24 h       →  75% refund
 *   1 – 4 h        →  50% refund
 *   < 1 h          →  25% refund
 *   already started / completed / cancelled → blocked
 *
 * Refunds are recorded as PENDING; back-office reconciliation pushes them to PROCESSED.
 */
// Default tiers used when no service-level policy is configured.
const DEFAULT_CANCELLATION_TIERS = [
  { minHoursBefore: 24, refundPercent: 100 },
  { minHoursBefore: 4,  refundPercent: 75  },
  { minHoursBefore: 1,  refundPercent: 50  },
  { minHoursBefore: 0,  refundPercent: 25  },
];

// Merges tiers from multiple services — takes the most lenient (highest refundPercent)
// at each minHoursBefore threshold. Returns [] if no service has tiers configured.
function mergeCancellationTiers(tiersArrays) {
  const flat = tiersArrays.flat();
  if (!flat.length) return [];
  const map = new Map();
  for (const t of flat) {
    const key = t.minHoursBefore;
    if (!map.has(key) || t.refundPercent > map.get(key)) {
      map.set(key, t.refundPercent);
    }
  }
  return [...map.entries()]
    .map(([minHoursBefore, refundPercent]) => ({ minHoursBefore, refundPercent }))
    .sort((a, b) => b.minHoursBefore - a.minHoursBefore);
}

// SINCE_BOOKING policy (cakes): refund keyed on hours ELAPSED since the
// booking was created, not hours remaining until the service. Tiers ascend by
// maxHoursAfterBooking; the first tier the elapsed time fits under wins.
// e.g. [{1, 100}, {8760, 50}] → within 1h of booking = 100%, afterwards = 50%.
function calculateSinceBookingRefund(totalAmount, hoursSinceBooking, tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) return { percent: 0, amount: 0 };
  const sorted = [...tiers].sort(
    (a, b) => Number(a.maxHoursAfterBooking) - Number(b.maxHoursAfterBooking)
  );
  for (const tier of sorted) {
    if (hoursSinceBooking <= Number(tier.maxHoursAfterBooking)) {
      const percent = Number(tier.refundPercent) || 0;
      return { percent, amount: Math.round(totalAmount * percent / 100) };
    }
  }
  // Elapsed time beyond the last tier — apply the final (least generous) tier
  // rather than silently refunding 0%.
  const last = sorted[sorted.length - 1];
  const percent = Number(last.refundPercent) || 0;
  return { percent, amount: Math.round(totalAmount * percent / 100) };
}

// Resolves refund percent from tiers sorted descending by minHoursBefore.
function calculateRefund(totalAmount, hoursToService, tiers) {
  if (hoursToService < 0) return { percent: 0, amount: 0 };
  let activeTiers = (tiers && tiers.length > 0) ? tiers : DEFAULT_CANCELLATION_TIERS;
  // Guarantee a 0-hour floor. A service-configured tier set without one would otherwise
  // let a customer cancelling below the lowest threshold silently drop to 0% — an
  // accidental under-refund. Fall back to the platform default floor instead of 0%.
  if (!activeTiers.some((t) => Number(t.minHoursBefore) <= 0)) {
    const defaultFloor = DEFAULT_CANCELLATION_TIERS[DEFAULT_CANCELLATION_TIERS.length - 1];
    activeTiers = [...activeTiers, { minHoursBefore: 0, refundPercent: defaultFloor.refundPercent }];
  }
  const sorted = [...activeTiers].sort((a, b) => b.minHoursBefore - a.minHoursBefore);
  for (const tier of sorted) {
    if (hoursToService >= tier.minHoursBefore) {
      const percent = tier.refundPercent;
      return { percent, amount: Math.round(totalAmount * percent / 100) };
    }
  }
  return { percent: 0, amount: 0 };
}

exports.cancelBookingByUser = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { reason = "" } = req.body || {};

    const booking = await Booking.findById(bookingId).populate("partner");
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    if (booking.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Unauthorized cancellation" });
    }

    if (["IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(booking.status)) {
      return res.status(400).json({
        message: `Cannot cancel from status ${booking.status}`,
      });
    }

    // Compute refund tier — only matters for PAID bookings; PENDING_PAYMENT returns 100%.
    const scheduledStart = booking.scheduledStartAt
      ? new Date(booking.scheduledStartAt)
      : buildDateTime(booking.scheduledDate, booking.scheduledTime);
    const hoursToService = (scheduledStart.getTime() - Date.now()) / (1000 * 60 * 60);

    let refund = { percent: 100, amount: 0 };
    if (booking.payment?.status === "PAID") {
      if (booking.status === "ARRIVED") {
        // The professional has already reached the customer's location. Cancelling
        // now forfeits the fee REGARDLESS of the clock — a partner who arrives early
        // would otherwise land in a positive-hours refund tier and get money back
        // despite being at the door. The customer apps' "Cancel (No Refund)" prompt
        // promises exactly this, so enforce it by status, not by hoursToService.
        refund = { percent: 0, amount: 0 };
      } else if (booking.status === "NEEDS_RESCHEDULING") {
        // A reschedule is the company's fault — the partner couldn't complete the
        // booking at the scheduled time. If the customer chooses to cancel instead
        // of rescheduling, they get a FULL refund with no late-cancellation penalty,
        // even though the original slot time has already passed (hoursToService < 0).
        refund = { percent: 100, amount: Number(booking.totalAmount || 0) };
      } else if (
        booking.cancellationPolicyTypeSnapshot === "SINCE_BOOKING" &&
        Array.isArray(booking.sinceBookingTiersSnapshot) &&
        booking.sinceBookingTiersSnapshot.length > 0
      ) {
        // Cake orders: refund depends on how long ago the booking was placed
        // (free-cancel window right after booking), not on time to service.
        const hoursSinceBooking =
          (Date.now() - new Date(booking.createdAt).getTime()) / (1000 * 60 * 60);
        refund = calculateSinceBookingRefund(
          Number(booking.totalAmount || 0),
          hoursSinceBooking,
          booking.sinceBookingTiersSnapshot
        );
      } else {
        refund = calculateRefund(
          Number(booking.totalAmount || 0),
          hoursToService,
          booking.cancellationTiersSnapshot
        );
      }
    }

    // ATOMIC STATE TRANSITION: Prevents race condition where partner completes 
    // the job exactly as the user cancels it.
    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: bookingId, status: booking.status }, // Optimistic lock: ensure status hasn't changed!
      {
        $set: {
          status: "CANCELLED",
          cancelledBy: "user",
          cancelledAt: new Date(),
          cancelReason: String(reason).trim().slice(0, 300),
          refundAmount: refund.amount,
          refundStatus: refund.amount > 0 ? "PENDING" : "NONE",
        }
      },
      { new: true }
    );

    if (!updatedBooking) {
      return res.status(409).json({
        success: false,
        message: "Booking state changed during cancellation. Please refresh."
      });
    }

    // Instant refund for the free-cancel window (cake orders cancelled within
    // 1h of booking, 100% refund) — the customer shouldn't have to wait for
    // manual back-office processing when they're getting their money back in
    // full. Any other tier/percent still goes through the existing manual
    // PENDING → back-office flow. Falls back to PENDING on any Razorpay error;
    // the cancellation itself has already succeeded above regardless.
    if (
      refund.amount > 0 &&
      refund.percent === 100 &&
      booking.cancellationPolicyTypeSnapshot === "SINCE_BOOKING" &&
      booking.payment?.razorpay_payment_id &&
      process.env.RAZORPAY_KEY_ID &&
      process.env.RAZORPAY_KEY_SECRET
    ) {
      try {
        const Razorpay = require("razorpay");
        const razorpay = new Razorpay({
          key_id: process.env.RAZORPAY_KEY_ID,
          key_secret: process.env.RAZORPAY_KEY_SECRET,
        });
        await razorpay.payments.refund(booking.payment.razorpay_payment_id, {
          amount: Math.round(refund.amount * 100),
        });
        await Booking.updateOne(
          { _id: booking._id },
          { $set: { refundStatus: "PROCESSED", refundProcessedAt: new Date() } }
        );
        updatedBooking.refundStatus = "PROCESSED";
      } catch (refundErr) {
        console.error(`[refund] Auto-refund failed for booking ${booking._id}:`, refundErr.message);
        // Leave refundStatus as PENDING (already set above) for manual processing.
      }
    }

    await releaseSlotCapacityByBookingId(booking._id, {
      releaseReason: "user_cancelled",
    });

    // Free up partner availability
    if (booking.partner) {
      await syncPartnerOperationalState(booking.partner._id);
    }
    for (const pId of booking.additionalPartners || []) {
      await syncPartnerOperationalState(pId);
    }

    // Bust slot cache so freed slot is visible to other customers immediately
    clearSlotCache(booking.pincode, booking.scheduledDate);

    // Notify partner — they need to know the booking is no longer in their queue
    if (global.io && booking.partner) {
      global.io.to(`partner_${booking.partner._id}`).emit("booking_cancelled", {
        bookingId: booking._id.toString(),
        cancelledBy: "user",
      });
    }

    // Push the partner too — the socket above only reaches them with the app
    // open. booking.partner is populated, so its fcmToken is available here.
    if (booking.partner?.fcmToken) {
      sendJobCancelledPush(booking.partner.fcmToken, booking._id.toString());
    }

    res.json({
      success: true,
      message: "Booking cancelled successfully",
      refund: {
        percent: refund.percent,
        amount: refund.amount,
        status: updatedBooking.refundStatus,
      },
      cancellationFee: Number(booking.totalAmount || 0) - refund.amount,
    });
  } catch (error) {
    console.error("cancelBookingByUser error:", error);
    res.status(500).json({ message: "Cancellation failed" });
  }
};

/* =======================
   USER: TRACK PARTNER LIVE LOCATION
======================= */
exports.getPartnerLiveLocation = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const booking = await Booking.findById(bookingId)
      .populate("partner", "location currentPincode currentAddress lastLocationAt isOnline")
      .select("user partner status pincode location");

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    if (String(booking.user) !== String(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!booking.partner) {
      return res.json({
        success: true,
        hasPartner: false,
        message: "Partner not assigned yet",
      });
    }

    const coordinates = Array.isArray(booking.partner.location?.coordinates)
      ? booking.partner.location.coordinates
      : [null, null];

    return res.json({
      success: true,
      hasPartner: true,
      bookingStatus: booking.status,
      partnerLocation: {
        latitude: Number(coordinates[1]) || null,
        longitude: Number(coordinates[0]) || null,
        pincode: booking.partner.currentPincode || "",
        address: booking.partner.currentAddress || "",
        isOnline: Boolean(booking.partner.isOnline),
        updatedAt: booking.partner.lastLocationAt || null,
      },
      customerLocation: {
        latitude: Number(booking.location?.coordinates?.[1]) || null,
        longitude: Number(booking.location?.coordinates?.[0]) || null,
        pincode: booking.pincode || "",
      },
    });
  } catch (error) {
    console.error("getPartnerLiveLocation error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch partner location",
    });
  }
};

/* =======================
   USER BOOKING HISTORY
======================= */
exports.getMyBookings = async (req, res) => {
  try {
    const page  = Math.max(1, Number(req.query.page)  || 1);
    const limit = Math.min(50, Number(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    // A booking the customer never paid for is not a booking from their
    // perspective. An abandoned/failed checkout leaves a PENDING_PAYMENT row
    // (created before Razorpay opens) until the stale cron cancels it — hide
    // both that row and its later system-cancelled form from My Bookings.
    // Paid bookings always show, including cancelled ones (they carry refund
    // info the customer needs); payment.status never leaves "PAID" once set.
    const visibleToCustomer = {
      user: req.user._id,
      $nor: [
        { status: "PENDING_PAYMENT" },
        { status: "CANCELLED", "payment.status": { $ne: "PAID" } },
      ],
    };

    const [bookings, total] = await Promise.all([
      Booking.find(visibleToCustomer)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("partner", CUSTOMER_PARTNER_FIELDS)
        .populate("services.serviceId", "name imageUrl duration")
        .populate("primaryService", "name imageUrl duration")
        .lean(),
      Booking.countDocuments(visibleToCustomer),
    ]);

    bookings.forEach(gateBookingSelfies);

    res.json({
      success: true,
      count: bookings.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      bookings,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

/* =======================
   GET ACTIVE CART (FOR HOMESCREEN)
======================= */
exports.getActiveCart = async (req, res) => {
  try {
    const activeCart = await Booking.findOne({
      user: req.user._id,
      status: "PENDING_PAYMENT",
    })
      .populate("services.serviceId", "name imageUrl description price duration")
      .select("services baseAmount discountAmount totalAmount status");

    const cartItemCount = activeCart && Array.isArray(activeCart.services)
      ? activeCart.services.reduce((sum, item) => sum + (item.quantity || 1), 0)
      : 0;

    res.json({
      success: true,
      activeCart: activeCart || null,
      cartItemCount,
    });
  } catch (err) {
    console.error("Get active cart error:", err);
    res.status(500).json({ message: "Server error while fetching cart" });
  }
};

/* =====================================================
   GET ESTIMATE  –  GET /api/booking/:bookingId/estimate
   Returns the pending estimate for a booking (user only).
===================================================== */
exports.getEstimate = async (req, res) => {
  try {
    const booking = await Booking.findOne({
      _id: req.params.bookingId,
      user: req.user._id,
    }).select("estimateItems estimateTotal estimateStatus estimateSubmittedAt");

    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    if (booking.estimateStatus === "none" || !booking.estimateItems?.length) {
      return res.status(404).json({ success: false, message: "No estimate available for this booking" });
    }

    const estimatePricingSettings = await getPricingSettings();
    const estimatePricing = calculatePricing({
      baseAmount: booking.estimateTotal,
      pricing: estimatePricingSettings,
    });

    return res.json({
      success: true,
      estimate: {
        items: booking.estimateItems,
        baseAmount: estimatePricing.baseAmount,
        platformFeeAmount: estimatePricing.platformFeeAmount,
        gstAmount: estimatePricing.gstAmount,
        totalAmount: estimatePricing.totalAmount,
        status: booking.estimateStatus,
        submittedAt: booking.estimateSubmittedAt,
      },
    });
  } catch (err) {
    console.error("getEstimate error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =====================================================
   RESPOND TO ESTIMATE  –  POST /api/booking/:bookingId/estimate/respond
   Customer approves or rejects the pending estimate.
===================================================== */
exports.respondToEstimate = async (req, res) => {
  try {
    const { approved } = req.body;
    if (typeof approved !== "boolean") {
      return res.status(400).json({ success: false, message: "approved (boolean) is required" });
    }

    const booking = await Booking.findOne({
      _id: req.params.bookingId,
      user: req.user._id,
    });

    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    if (booking.estimateStatus !== "pending") {
      return res.status(409).json({ success: false, message: "Estimate already responded to or not pending" });
    }

    booking.estimateStatus = approved ? "approved" : "rejected";
    if (approved) booking.estimateApprovedAt = new Date();
    else booking.estimateRejectedAt = new Date();
    await booking.save();

    // Notify the partner in real time
    if (global.io && booking.partner) {
      global.io.to(`partner_${booking.partner}`).emit("estimate_response", {
        bookingId: booking._id.toString(),
        approved,
      });
    }

    return res.json({
      success: true,
      message: approved
        ? "Estimate approved. Your technician will proceed with the work."
        : "Estimate rejected. Your technician has been notified.",
    });
  } catch (err) {
    console.error("respondToEstimate error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getBookingById = async (req, res) => {
  try {
    const booking = await Booking.findOne({
      _id: req.params.bookingId,
      user: req.user._id,
    })
      .populate("partner", CUSTOMER_PARTNER_FIELDS)
      .populate("additionalPartners", CUSTOMER_PARTNER_FIELDS)
      .lean();

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    gateBookingSelfies(booking);

    // Surface the latest unresolved "customer-fault" on-site report while the
    // partner is still at the door (ARRIVED), so the app can show a clear
    // "cancel — no refund" prompt even after a reload. Null otherwise.
    booking.partnerReportedIssue = null;
    if (booking.status === "ARRIVED" && Array.isArray(booking.partnerReports)) {
      const latest = booking.partnerReports
        .filter((r) => CUSTOMER_FAULT_ISSUE_TYPES.includes(r.issueType))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      if (latest) booking.partnerReportedIssue = latest.issueType;
    }

    return res.json({ success: true, booking });
  } catch (err) {
    console.error("getBookingById error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =======================
   CUSTOMER RESCHEDULES BOOKING
   Only allowed when status is NEEDS_RESCHEDULING
======================= */
exports.rescheduleBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { scheduledDate, scheduledTime } = req.body;

    if (!scheduledDate || !scheduledTime) {
      return res.status(400).json({ success: false, message: "scheduledDate and scheduledTime are required" });
    }

    const booking = await Booking.findOne({ _id: bookingId, user: req.user._id });
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });

    if (booking.status !== "NEEDS_RESCHEDULING") {
      return res.status(400).json({ success: false, message: "This booking does not need rescheduling" });
    }

    // Validate the new slot is in the future
    let newStart;
    try {
      newStart = buildDateTime(scheduledDate, scheduledTime);
    } catch (dtErr) {
      return res.status(400).json({ success: false, message: dtErr.message });
    }
    if (newStart.getTime() < Date.now() - 5 * 60 * 1000) {
      return res.status(400).json({ success: false, message: "Please select a future time slot" });
    }

    const newEnd = new Date(
      newStart.getTime() + (booking.estimatedDurationMinutes || 60) * 60 * 1000
    );

    // Free the old slot's reserved capacity — the old window is dead whether
    // or not the new reservation succeeds (NEEDS_RESCHEDULING is only entered
    // after the original window already failed). Previously the old units were
    // never released AND the new slot was never reserved, so reschedules both
    // leaked capacity and could oversell the new window.
    await releaseSlotCapacityByBookingId(booking._id, {
      releaseReason: "rescheduled",
    });

    // Reserve capacity in the NEW slot — same oversell guarantee that
    // createBooking gives. 409 if the chosen window is already full.
    try {
      await reserveSlotCapacityForBooking({
        ...booking.toObject(),
        scheduledDate: new Date(scheduledDate),
        scheduledTime,
        scheduledStartAt: newStart,
        scheduledEndAt: newEnd,
      });
    } catch (reserveError) {
      const code = reserveError?.statusCode === 409 ? 409 : reserveError?.statusCode || 500;
      if (code !== 409) console.error("rescheduleBooking reserve error:", reserveError);
      return res.status(code).json({
        success: false,
        message: reserveError.message || "Selected slot is no longer available",
      });
    }

    // The booking is already paid (partners are only ever assigned after
    // payment), so convert the fresh reservation to a permanent hold now —
    // otherwise the 10-minute payment-lock cleanup cron would reap it.
    await markSlotLockPaid(booking._id);

    // Atomic, guarded transition: apply the new slot only if the booking is STILL
    // NEEDS_RESCHEDULING. This optimistic lock stops a concurrent reassign (full-doc save)
    // from clobbering the reschedule, and vice-versa. Old-slot values come from the read
    // above; the status guard guarantees nothing changed underneath us.
    const rescheduled = await Booking.findOneAndUpdate(
      { _id: bookingId, user: req.user._id, status: "NEEDS_RESCHEDULING" },
      {
        $set: {
          rescheduledFromDate: booking.scheduledDate ? new Date(booking.scheduledDate).toISOString().slice(0, 10) : null,
          rescheduledFromTime: booking.scheduledTime || null,
          scheduledDate: new Date(scheduledDate),
          scheduledTime: scheduledTime,
          scheduledStartAt: newStart,
          scheduledEndAt: newEnd,
          status: "SEARCHING",
          partner: null,
          ackReceivedAt: null,
          // The reservation above is a paid/permanent hold — clear the
          // payment-lock expiry fields reserveSlotCapacityForBooking wrote.
          lockedUntil: null,
          slotReservationExpiresAt: null,
          // The customer chose to wait for a new slot — if it can't be filled, escalate to
          // ops, do NOT auto-cancel them out (clears any flag left by an earlier partner cancel).
          autoRefundIfUnassigned: false,
        },
      },
      { new: true }
    );

    if (!rescheduled) {
      // Roll back the fresh reservation — the booking moved on concurrently
      // (e.g. the user cancelled in another tab). Idempotent, so a concurrent
      // cancel's own release racing this one is harmless.
      await releaseSlotCapacityByBookingId(booking._id, {
        releaseReason: "reschedule_race_rollback",
      });
      return res.status(409).json({ success: false, message: "Booking state changed — please refresh and try again." });
    }

    // Clear slot cache for both old and new dates
    clearSlotCache(booking.pincode, scheduledDate);
    if (booking.scheduledDate) {
      clearSlotCache(booking.pincode, booking.scheduledDate);
    }

    // Notify customer
    if (global.io) {
      global.io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: booking._id.toString(),
        status: "SEARCHING",
      });
    }

    // Trigger assignment for the new slot
    const { assignBooking } = require("../services/assignmentEngine");
    assignBooking(booking._id, { queueOnFailure: true }).catch(() => {});

    return res.json({ success: true, message: "Booking rescheduled. We are finding a partner for your new slot." });
  } catch (err) {
    console.error("rescheduleBooking error:", err);
    return res.status(500).json({ success: false, message: "Reschedule failed" });
  }
};
