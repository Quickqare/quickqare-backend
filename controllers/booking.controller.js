const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");
const mongoose = require("mongoose");
const Category = require("../models/Category");
const { creditWallet } = require("./partnerWallet.controller");
const { getAvailableSlots } = require("../services/slotAvailability_service");
const { assignBooking, reassignBooking } = require("../services/assignmentEngine");
const { deriveH3Cell } = require("../utils/h3");
const { forwardGeocode } = require("../services/geocode.service");
const {
  getZoneServiceKeysFromValues,
  isZoneServiceEnabled,
  resolveZoneForPincode,
  resolveHubForLocation,
} = require("../services/zone.service");
const { getUseH3Flag } = require("../services/assignmentEngine");
const {
  buildDateTime,
  clearSlotCache,
  syncPartnerOperationalState,
  AC_MAX_CAPACITY_MINUTES,
  AC_CATEGORY_SLUGS,
} = require("../services/scheduling_service");
const { calculatePricing, getPricingSettings } = require("../utils/pricing");
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

      const hub =
        Number.isFinite(lat) && Number.isFinite(lng)
          ? await resolveHubForLocation(lat, lng, { ringFallback })
          : null;

      if (!hub || hub.isActive === false) {
        return res.status(403).json({
          success: false,
          message: "Service not available in this area",
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
          message: "Service is currently unavailable in this area",
        });
      }

      if (Number.isFinite(lat) && Number.isFinite(lng)) {
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

        const itemTotal = price * quantity;
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
          price,
          lineTotal: itemTotal,
          quantity,
          category: categoryValue,
          subCategory: subCategoryValue,
        });

        // Collect cancellation tiers from each service for snapshot
        if (Array.isArray(service.cancellationTiers) && service.cancellationTiers.length > 0) {
          allServiceCancellationTiers.push(service.cancellationTiers);
        }
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

      const legacyCategorySlug = await resolveServiceCategorySlug(legacyService);

      // Push one representative entry so the outer zone check picks it up.
      // Pricing stays on the legacy BASE_PRICE path below — this is for
      // validation only.
      bookingServices.push({
        serviceId: legacyService._id,
        name: legacyService.name,
        price: 500,
        lineTotal: 500,
        quantity: 1,
        category:
          legacyCategorySlug ||
          (legacyService.category ? String(legacyService.category) : ""),
        subCategory: legacyService.subCategory
          ? String(legacyService.subCategory)
          : "",
      });

      const BASE_PRICE = 500; // your existing logic
      baseAmount = BASE_PRICE;
      finalPrimaryService = serviceId;
      totalDurationMinutes = 60;
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
   PARTNER STARTS SERVICE
   Transition from arrival to in-progress without OTP gating.
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

        // ATOMIC ARRAY UPDATE: the $elemMatch guard requires this partner's
        // allocation to be not-yet-COMPLETED. Two concurrent completeBooking
        // calls from the same partner therefore can't both pass — only the
        // first flips the element and reaches the payout below. The earlier
        // allocation.status check is a stale in-memory read and cannot stop a
        // true concurrent double-tap; this guard does.
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

        // Pay this individual immediately
        currentPartnerShare = roundAmount(settlement.partnerEarningAmount * allocation.payoutRatio);
        await creditWallet({
          partnerId: partnerId,
          amount: currentPartnerShare,
          reason: "job_payment",
          bookingId: booking._id,
          description: `Earning from booking #${booking._id} (Pending 48h Settlement)`,
          bucket: "pending",
        });
        
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
       DAILY CANCEL LIMIT (1 per calendar day)
    ===================== */
    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    if (partner.lastDailyCancelDate === todayStr) {
      if (partner.dailyCancelCount >= PARTNER_DAILY_CANCEL_LIMIT) {
        return res.status(400).json({
          message: `You can only cancel ${PARTNER_DAILY_CANCEL_LIMIT} job per day. Try again tomorrow.`,
        });
      }
      partner.dailyCancelCount += 1;
    } else {
      partner.dailyCancelCount = 1;
      partner.lastDailyCancelDate = todayStr;
    }

    /* =====================
       ROLLING 7-DAY CANCEL WINDOW (for auto-suspension)
    ===================== */
    // Use epoch (0) as the safe default so a null lastCancelReset always triggers a reset,
    // rather than comparing against NaN (which is what `new Date(null)` produces in some runtimes).
    const lastReset = partner.lastCancelReset ? new Date(partner.lastCancelReset) : new Date(0);
    const diffDays = (now.getTime() - lastReset.getTime()) / (1000 * 60 * 60 * 24);

    if (diffDays >= 7) {
      partner.weeklyCancelCount = 0;
      partner.lastCancelReset = now;
    }

    if (partner.weeklyCancelCount >= PARTNER_WEEKLY_CANCEL_LIMIT) {
      return res.status(400).json({
        message: `Weekly cancel limit reached (${PARTNER_WEEKLY_CANCEL_LIMIT} per week). Account suspended.`,
      });
    }

    partner.weeklyCancelCount += 1;

    // Auto-suspend at the weekly limit — admin must manually unblock
    if (partner.weeklyCancelCount >= PARTNER_WEEKLY_CANCEL_LIMIT) {
      partner.isBlocked = true;
      console.warn(`[AUTO-SUSPEND] Partner ${partner._id} (${partner.name}) suspended after ${partner.weeklyCancelCount} weekly cancellations`);
    }

    /* =====================
       FREE SLOT + LOAD
    ===================== */
    await partner.save();
    await syncPartnerOperationalState(partner._id);

    // Atomically release the booking before kicking off reassignment.
    // Without this, if reassignBooking later throws inside its internal
    // try/catch, the booking stays pointed at this partner forever (zombie
    // state). With it, the booking is at minimum left in SEARCHING for a
    // retry/admin recovery, even if reassignment fails.
    const releasedBooking = await Booking.findOneAndUpdate(
      {
        _id: booking._id,
        status: { $in: ["ASSIGNED", "CONFIRMED", "PARTNER_ACCEPTED", "ON_THE_WAY", "ARRIVED"] },
      },
      {
        $set:  { status: "SEARCHING", partner: null },
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

// Resolves refund percent from tiers sorted descending by minHoursBefore.
function calculateRefund(totalAmount, hoursToService, tiers) {
  if (hoursToService < 0) return { percent: 0, amount: 0 };
  const activeTiers = (tiers && tiers.length > 0) ? tiers : DEFAULT_CANCELLATION_TIERS;
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
      refund = calculateRefund(
        Number(booking.totalAmount || 0),
        hoursToService,
        booking.cancellationTiersSnapshot
      );
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

    const [bookings, total] = await Promise.all([
      Booking.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("partner", "name phone")
        .populate("services.serviceId", "name imageUrl duration")
        .populate("primaryService", "name imageUrl duration")
        .lean(),
      Booking.countDocuments({ user: req.user._id }),
    ]);

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
      .populate("partner", "name phone rating")
      .populate("additionalPartners", "name phone rating")
      .lean();

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
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

    // Save old slot for reference, update to new slot, move back to SEARCHING
    booking.rescheduledFromDate = booking.scheduledDate ? new Date(booking.scheduledDate).toISOString().slice(0, 10) : null;
    booking.rescheduledFromTime = booking.scheduledTime || null;
    booking.scheduledDate = new Date(scheduledDate);
    booking.scheduledTime = scheduledTime;
    booking.scheduledStartAt = newStart;
    booking.scheduledEndAt = new Date(newStart.getTime() + (booking.estimatedDurationMinutes || 60) * 60 * 1000);
    booking.status = "SEARCHING";
    booking.partner = null;
    booking.ackReceivedAt = null;
    await booking.save();

    // Clear slot cache for both old and new pincode/date
    const { clearSlotCache } = require("../services/scheduling_service");
    clearSlotCache(booking.pincode, scheduledDate);

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
