const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");
const mongoose = require("mongoose");
const Category = require("../models/Category");
const { creditWallet } = require("./partnerWallet.controller");
const { getAvailableSlots } = require("../services/slotAvailability_service");
const { assignBooking, reassignBooking } = require("../services/assignmentEngine");
const {
  getZoneServiceKeysFromValues,
  isZoneServiceEnabled,
  resolveZoneForPincode,
} = require("../services/zone.service");
const {
  buildDateTime,
  clearSlotCache,
  syncPartnerOperationalState,
} = require("../services/scheduling_service");
const { calculatePricing } = require("../utils/pricing");
const { validateCouponForAmount } = require("../services/coupon.service");
const {
  SLOT_LOCK_MINUTES,
  markSlotLockPaid,
  releaseSlotCapacityByBookingId,
  reserveSlotCapacityForBooking,
} = require("../services/slotCapacity.service");

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
      couponCode,
    } = req.body;

    if (!pincode) {
      return res.status(400).json({
        success: false,
        message: "pincode is required",
      });
    }

    const zone = await resolveZoneForPincode(pincode);
    if (!zone || zone.isActive === false) {
      return res.status(403).json({
        success: false,
        message: "Service not available in this pincode",
      });
    }
    if (zone.customerAppEnabled === false || zone.partnerAppEnabled === false) {
      return res.status(403).json({
        success: false,
        message: "Customer app is disabled for this pincode",
      });
    }

    let bookingServices = [];
    let baseAmount = 0;
    let finalPrimaryService = primaryService;
    const categorySlugCache = new Map();
    let totalDurationMinutes = 0;
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
        const configuredPrice = Number(service.price || 0);
        const fallbackClientPrice = Number(item.price || 0);
        const price =
          configuredPrice > 0 ? configuredPrice : fallbackClientPrice;
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

      const zoneServiceKeys = getZoneServiceKeysFromValues([
        serviceCategory,
        ...bookingServices.map((item) => item.category),
        ...bookingServices.map((item) => item.name),
      ]);

      if (!isZoneServiceEnabled(zone, zoneServiceKeys)) {
        return res.status(403).json({
          success: false,
          message: "Selected service is not enabled in this pincode",
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

    if (!isZoneServiceEnabled(zone, zoneServiceKeys)) {
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
        });

        discountAmount = couponResult.discount;
        appliedCoupon = couponResult.coupon;
      }

      /* =====================
         PRICE CALCULATION
      ===================== */
      const pricing = calculatePricing({
      baseAmount,
      discount: discountAmount,
    });

    const scheduledStartAt = buildDateTime(scheduledDate, scheduledTime);
    const estimatedDurationMinutes = Math.min(Math.max(totalDurationMinutes || 60, 1), 240);
    const scheduledEndAt = new Date(
      scheduledStartAt.getTime() + estimatedDurationMinutes * 60 * 1000
    );

    /* =====================
       CREATE BOOKING + RESERVE SLOT CAPACITY
       The reservation is written before payment starts so two customers cannot
       both pay for the same limited slot.
    ===================== */
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
      address: String(address || "").trim(),
      couponCode: appliedCoupon ? appliedCoupon.code : null,
      couponId: appliedCoupon ? appliedCoupon._id : null,
      couponDiscountAmount: discountAmount,
      baseAmount: pricing.baseAmount,
      discountAmount: pricing.discountAmount,
      gstAmount: pricing.gstAmount,
      totalAmount: pricing.totalAmount,
      scheduledDate: new Date(scheduledDate),
      scheduledTime,
      scheduledStartAt,
      scheduledEndAt,
      estimatedDurationMinutes,
      location,
      lockedUntil: new Date(Date.now() + PAYMENT_LOCK_MINUTES * 60 * 1000),
      lockedCapacityMinutes: estimatedDurationMinutes,
      payment: { status: "PENDING" },
      status: "PENDING_PAYMENT",
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

    const timeToServiceMs = scheduledStart.getTime() - Date.now();
    const hoursToService = timeToServiceMs / (1000 * 60 * 60);

    if (hoursToService > 24) {
      booking.status = "QUEUED";
      await booking.save();

      // Tell the customer their booking is confirmed and queued — without this the
      // BookingStatusScreen sits on PENDING_PAYMENT until partner assignment runs
      // hours later, which looks like the payment failed.
      if (global.io) {
        global.io.to(`user_${booking.user}`).emit("booking_update", {
          bookingId: booking._id.toString(),
          status: "QUEUED",
          paymentConfirmed: true,
        });
      }

      res.json({
        success: true,
        message: "Payment verified. Booking queued for partner assignment closer to the service date.",
      });
    } else {
      // Use SEARCHING (a public-facing status the BookingStatusScreen timeline
      // recognises) so the customer immediately sees "Searching for Partner".
      // assignBooking's atomic lock will flip this through ASSIGNING_LOCK → ASSIGNED
      // within a moment; we still emit the SEARCHING update first for instant feedback.
      booking.status = "SEARCHING";
      await booking.save();

      if (global.io) {
        global.io.to(`user_${booking.user}`).emit("booking_update", {
          bookingId: booking._id.toString(),
          status: "SEARCHING",
          paymentConfirmed: true,
        });
      }

      // 🚀 QUEUE ASSIGNMENT (Simulating batch dispatch)
      await assignBooking(booking._id);

      res.json({
        success: true,
        message: "Payment verified. Searching for partner.",
      });
    }
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

    booking.status = "ARRIVED";
    booking.arrivedAt = new Date();
    await booking.save();

    if (global.io) {
      global.io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: booking._id.toString(),
        status: "ARRIVED",
        arrivedAt: booking.arrivedAt,
      });
    }

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
      
      if (allocation) {
        if (allocation.status === "COMPLETED") {
          return res.status(400).json({ success: false, message: "You have already completed your part." });
        }

        // ATOMIC ARRAY UPDATE: Prevent teammates completing exactly at the same time from overwriting each other
        const arrayUpdate = await Booking.findOneAndUpdate(
          { _id: bookingId, "teamAllocations.partnerId": partnerId },
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

      if (global.io) {
        global.io.to(`user_${booking.user}`).emit("jobCompleted", {
          bookingId: booking._id,
          message: "Your service has been completed",
        });
      }

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

    res.json({
      success: true,
      message: `Booking fully completed! ₹${currentPartnerShare} credited to your wallet.`,
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

exports.cancelBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;

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

    /* =====================
       ROLLING 7-DAY CANCEL WINDOW
    ===================== */
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const diffDays = (now - new Date(partner.lastCancelReset || 0)) / (1000 * 60 * 60 * 24);

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

    // Bust slot cache so the freed slot is visible to other customers
    // immediately (without waiting for the 30s TTL).
    clearSlotCache(booking.pincode, booking.scheduledDate);

    /* =====================
       REASSIGN BOOKING
    ===================== */
    await reassignBooking(booking._id, partner._id);

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
function calculateRefund(totalAmount, hoursToService) {
  if (hoursToService < 0) return { percent: 0, amount: 0 }; // service already past
  if (hoursToService > 24) return { percent: 100, amount: totalAmount };
  if (hoursToService > 4)  return { percent: 75,  amount: Math.round(totalAmount * 0.75) };
  if (hoursToService > 1)  return { percent: 50,  amount: Math.round(totalAmount * 0.50) };
  return { percent: 25, amount: Math.round(totalAmount * 0.25) };
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
      refund = calculateRefund(Number(booking.totalAmount || 0), hoursToService);
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

    res.json({
      success: true,
      message: "Booking cancelled successfully",
      refund: {
        percent: refund.percent,
        amount: refund.amount,
        status: booking.refundStatus,
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

    return res.json({
      success: true,
      estimate: {
        items: booking.estimateItems,
        baseAmount: booking.estimateTotal,
        gstAmount: 0,
        totalAmount: booking.estimateTotal,
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
    }).lean();

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    return res.json({ success: true, booking });
  } catch (err) {
    console.error("getBookingById error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
