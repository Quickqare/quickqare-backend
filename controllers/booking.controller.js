const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");
const mongoose = require("mongoose");
const Zone = require("../models/zone.model");
const Category = require("../models/Category");
const { creditWallet } = require("./partnerWallet.controller");
const { getAvailableSlots } = require("../services/slotAvailability.service");
const { assignBooking, reassignBooking } = require("../services/assignmentEngine");
const {
  buildDateTime,
  findEligiblePartnersForBooking,
  syncPartnerOperationalState,
} = require("../services/scheduling.service");
const { calculatePricing } = require("../utils/pricing");
const { validateCouponForAmount } = require("../services/coupon.service");

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

    const zone = await Zone.findOne({ pincode });
    if (zone && zone.isActive === false) {
      return res.status(403).json({
        success: false,
        message: "Service not available in this pincode",
      });
    }
    if (zone && zone.customerAppEnabled === false) {
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

    const slotCandidates = await findEligiblePartnersForBooking(
      {
        services: bookingServices,
        serviceId,
        serviceCategory:
          typeof serviceCategory === "string" && serviceCategory.trim()
            ? serviceCategory.trim()
            : bookingServices[0]?.category || "general",
        scheduledDate: new Date(scheduledDate),
        scheduledTime,
        scheduledStartAt,
        scheduledEndAt,
        estimatedDurationMinutes,
        location,
        pincode,
        rejectedPartners: [],
      },
      [pincode]
    );

    if (!slotCandidates.length) {
      return res.status(409).json({
        success: false,
        message: "Selected slot is no longer available",
      });
    }

    /* =====================
       CREATE BOOKING
    ===================== */
    const booking = await Booking.create({
      user: req.user._id,

      // new multi service
      services: bookingServices,
      primaryService: finalPrimaryService,

      // backward compatibility
      serviceCategory:
        typeof serviceCategory === "string" && serviceCategory.trim()
          ? serviceCategory.trim()
          : bookingServices[0]?.category || "general",
      serviceId,

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

      lockedUntil: new Date(Date.now() + 5 * 60 * 1000), // 5 min lock
      lockedCapacityMinutes: estimatedDurationMinutes,

      payment: { status: "PENDING" },
      status: "PENDING_PAYMENT",
    });

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
    booking.status = "PENDING_ASSIGNMENT";
    booking.lockedUntil = null; // Convert lock to permanent capacity
    await booking.save();

    // 🚀 QUEUE ASSIGNMENT (Simulating batch dispatch)
    await assignBooking(booking._id);

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
======================= */
exports.markOnTheWay = async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId);
  booking.status = "ON_THE_WAY";
  await booking.save();

  res.json({
    success: true,
    message: "Partner is on the way",
  });
};

/* =======================
   PARTNER STARTS SERVICE
======================= */
exports.startService = async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId);
  booking.status = "IN_PROGRESS";
  await booking.save();

  res.json({
    success: true,
    message: "Service started",
  });
};

/* =======================
   PARTNER COMPLETES BOOKING
======================= */
exports.completeBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const partnerId = req.partner?._id || req.body?.partnerId; // Identify who pressed complete

    const booking = await Booking.findById(bookingId).populate("partner");

    if (!booking) return res.status(404).json({ message: "Booking not found" });

    if (booking.status !== "IN_PROGRESS") {
      return res.status(400).json({ message: "Booking not in progress" });
    }

    const partner = booking.partner;
    const settlement = await calculatePartnerSettlement(booking, partner);

    const teamAllocations = booking.get("teamAllocations") || [];
    const additionalPartners = booking.get("additionalPartners") || [];

    let currentPartnerShare = 0;

    // --- INDIVIDUAL PAYOUT & COMPLETION ---
    if (partnerId && teamAllocations.length > 0) {
      const allocation = teamAllocations.find(a => a.partnerId?.toString() === partnerId.toString());
      
      if (allocation) {
        if (allocation.status === "COMPLETED") {
          return res.status(400).json({ success: false, message: "You have already completed your part." });
        }

        allocation.status = "COMPLETED";
        allocation.completedAt = new Date();

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

        const pendingPartners = teamAllocations.filter(a => a.status !== "COMPLETED");
        if (pendingPartners.length > 0) {
          await booking.save();
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
    }

    booking.status = "COMPLETED";
    booking.completedAt = new Date();
    booking.isPaidToPartner = false;
    booking.partnerSettlement = {
      grossAmount: settlement.grossAmount,
      commissionAmount: settlement.commissionAmount,
      partnerEarningAmount: settlement.partnerEarningAmount,
      status: "UNSETTLED",
      settledAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hour delay
      paidOutAt: null,
    };
    await booking.save();

    /* =====================
       PROCESS REFERRAL REWARD
    ===================== */
    const { processReferralReward } = require("../utils/referral");
    await processReferralReward(booking.user, booking._id);

       NOTIFY USER
    ===================== */
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
    res.status(500).json({ message: error.message });
  }
};

/* =======================
   PARTNER CANCELS BOOKING
   (MAX 2 PER WEEK + REASSIGN)
======================= */
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
       RESET WEEKLY LIMIT
    ===================== */
    const now = new Date();
    const diffDays = (now - partner.lastCancelReset) / (1000 * 60 * 60 * 24);

    if (diffDays >= 7) {
      partner.weeklyCancelCount = 0;
      partner.lastCancelReset = now;
    }

    if (partner.weeklyCancelCount >= 2) {
      return res.status(400).json({
        message: "Weekly cancel limit reached (2 per week)",
      });
    }

    partner.weeklyCancelCount += 1;

    /* =====================
       FREE SLOT + LOAD
    ===================== */
    await partner.save();
    await syncPartnerOperationalState(partner._id);

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
exports.cancelBookingByUser = async (req, res) => {
  try {
    const { bookingId } = req.params;

    const booking = await Booking.findById(bookingId).populate("partner");

    if (!booking) return res.status(404).json({ message: "Booking not found" });

    if (booking.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Unauthorized cancellation" });
    }

    if (["IN_PROGRESS", "COMPLETED"].includes(booking.status)) {
      return res.status(400).json({
        message: "Cannot cancel after service started",
      });
    }

    booking.status = "CANCELLED";
    booking.cancelledBy = "user";
    await booking.save();

    // free partner slot
    if (booking.partner) {
      await syncPartnerOperationalState(booking.partner._id);
    }
    const additionalPartners = booking.get("additionalPartners") || [];
    for (const pId of additionalPartners) {
      await syncPartnerOperationalState(pId);
    }

    res.json({
      success: true,
      message: "Booking cancelled successfully",
    });
  } catch (error) {
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
    const bookings = await Booking.find({ user: req.user._id }).sort({
      createdAt: -1,
    });

    res.json({
      success: true,
      count: bookings.length,
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
