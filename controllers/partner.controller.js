const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const Dispute = require("../admin/models/Dispute");
const Service = require("../models/service.model");
const CatalogItem = require("../models/CatalogItem");
const SubCategory = require("../models/SubCategory");
const { reverseGeocode } = require("../services/geocode.service");
const { syncPartnerOperationalState } = require("../services/scheduling_service");
const { emitBookingUpdate } = require("../socket/emitters");
const { completeBooking } = require("./booking.controller");
const { deriveH3Cell } = require("../utils/h3");
const {
  filterServicesByZone,
  resolveZoneForPincode,
  resolveHubForLocation,
} = require("../services/zone.service");
const { getUseH3Flag } = require("../services/assignmentEngine");

function toPartnerJobPayload(booking, partnerId, { isPartnerCancelled = false } = {}) {
  const firstService = Array.isArray(booking?.services) ? booking.services[0] || {} : {};
  // Trim each candidate so a blank/whitespace-only name falls through to the next
  // option instead of rendering as an empty card title in the partner app.
  const firstServiceName =
    String(firstService?.name || "").trim() ||
    String(booking?.serviceCategory || "").trim() ||
    "Service";
  const customerLongitude = Array.isArray(booking?.location?.coordinates)
    ? Number(booking.location.coordinates[0])
    : null;
  const customerLatitude = Array.isArray(booking?.location?.coordinates)
    ? Number(booking.location.coordinates[1])
    : null;

  let amount = Number(booking?.totalAmount || 0);
  let isTeamJob = false;
  let isPrimary = true;

  if (partnerId) {
    // booking is a lean() plain object — use direct property access, not .get()
    const allocations = Array.isArray(booking.teamAllocations) ? booking.teamAllocations : [];
    const myAllocation = allocations.find(a => a.partnerId?.toString() === partnerId.toString());
    if (allocations.length > 1) isTeamJob = true;
    if (myAllocation) {
      amount = Number((amount * (myAllocation.payoutRatio || 1)).toFixed(2));
      isPrimary = Boolean(myAllocation.isPrimary);
    }
  }

  // CONFIRMED = auto-accepted on the backend. Return PARTNER_ACCEPTED so the
  // partner app treats it identically to a manually accepted job.
  // isPartnerCancelled = this partner cancelled the booking; override status to CANCELLED.
  const partnerStatus = isPartnerCancelled
    ? "CANCELLED"
    : booking?.status === "CONFIRMED" ? "PARTNER_ACCEPTED" : (booking?.status || "ASSIGNED");

  const helpers = Array.isArray(booking?.helpers)
    ? booking.helpers.map((h) => ({
        partnerId: String(h?.partnerId || ""),
        name: String(h?.name || ""),
        phone: String(h?.phone || ""),
      }))
    : [];

  return {
    id: String(booking?._id || ""),
    bookingId: String(booking?._id || ""),
    serviceName: String(firstServiceName),
    serviceCategory: booking?.serviceCategory || firstService?.category || "general",
    customerName: booking?.user?.name || "Customer",
    customerPhone: booking?.user?.phone || "",
    address: String(booking?.address || "").trim(),
    houseDetails: booking?.houseDetails ? String(booking.houseDetails).trim() : null,
    landmark: booking?.landmark ? String(booking.landmark).trim() : null,
    pincode: booking?.pincode ? String(booking.pincode) : "",
    customerLatitude: Number.isFinite(customerLatitude) ? customerLatitude : null,
    customerLongitude: Number.isFinite(customerLongitude) ? customerLongitude : null,
    amount,
    price: amount,
    isTeamJob,
    isPrimary,
    helpers,
    scheduledDate: booking?.scheduledDate || null,
    scheduledTime: booking?.scheduledTime || "",
    status: partnerStatus,
    autoAccepted: booking?.status === "CONFIRMED",
    createdAt: booking?.createdAt || new Date(),
    updatedAt: booking?.updatedAt || new Date(),
  };
}

/**
 * =====================================================
 * PARTNER ACCEPT BOOKING
 * ASSIGNED → CONFIRMED
 * =====================================================
 */
exports.acceptBooking = async (req, res) => {
  try {
    const partnerId = req.partner._id;
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: "bookingId is required",
      });
    }

    let booking = await Booking.findOneAndUpdate(
      {
        _id: bookingId,
        $or: [{ partner: partnerId }, { additionalPartners: partnerId }],
        status: "ASSIGNED",
      },
      {
        status: "CONFIRMED",
      },
      { new: true }
    )
      .populate("services.serviceId") // NEW (multi-service)
      .populate("primaryService"); // NEW

    if (!booking) {
      booking = await Booking.findOne({
        _id: bookingId,
        $or: [{ partner: partnerId }, { additionalPartners: partnerId }],
        status: { $ne: "ASSIGNED" }
      }).populate("services.serviceId").populate("primaryService");
      if (booking) {
        return res.json({ success: true, message: "Booking state already updated", booking });
      }
      return res.status(409).json({
        success: false,
        message: "Booking not available",
      });
    }

    emitBookingUpdate(booking);

    return res.json({
      success: true,
      message: "Booking accepted",
      booking,
    });
  } catch (err) {
    console.error("Accept booking error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/**
 * =====================================================
 * PARTNER ON THE WAY
 * ASSIGNED / CONFIRMED → ON_THE_WAY
 * =====================================================
 */
exports.markOnTheWay = async (req, res) => {
  try {
    const partnerId = req.partner._id;
    const { bookingId } = req.body;

    let booking = await Booking.findOneAndUpdate(
      {
        _id: bookingId,
        $or: [{ partner: partnerId }, { additionalPartners: partnerId }],
        status: { $in: ["ASSIGNED", "CONFIRMED", "PARTNER_ACCEPTED"] },
      },
      {
        status: "ON_THE_WAY",
        onTheWayAt: new Date(),
      },
      { new: true }
    )
      .populate("services.serviceId")
      .populate("primaryService");

    if (!booking) {
      booking = await Booking.findOne({
        _id: bookingId,
        $or: [{ partner: partnerId }, { additionalPartners: partnerId }]
      }).populate("services.serviceId").populate("primaryService");
      if (booking && ["ON_THE_WAY", "IN_PROGRESS", "COMPLETED"].includes(booking.status)) {
        return res.json({ success: true, message: "Already updated", booking });
      }
      return res.status(409).json({
        success: false,
        message: "Booking not available",
      });
    }

    emitBookingUpdate(booking);

    return res.json({
      success: true,
      message: "Partner is on the way",
      booking,
    });
  } catch (err) {
    console.error("ON_THE_WAY error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/**
 * =====================================================
 * PARTNER START JOB
 * ON_THE_WAY → IN_PROGRESS
 * =====================================================
 */
exports.markInProgress = async (req, res) => {
  try {
    const partnerId = req.partner._id;
    const { bookingId } = req.body;

    let booking = await Booking.findOneAndUpdate(
      {
        _id: bookingId,
        $or: [{ partner: partnerId }, { additionalPartners: partnerId }],
        status: "ON_THE_WAY",
      },
      {
        status: "IN_PROGRESS",
        inProgressAt: new Date(),
      },
      { new: true }
    )
      .populate("services.serviceId")
      .populate("primaryService");

    if (!booking) {
      booking = await Booking.findOne({
        _id: bookingId,
        $or: [{ partner: partnerId }, { additionalPartners: partnerId }]
      }).populate("services.serviceId").populate("primaryService");
      if (booking && ["IN_PROGRESS", "COMPLETED"].includes(booking.status)) {
        return res.json({ success: true, message: "Already updated", booking });
      }
      return res.status(409).json({
        success: false,
        message: "Booking not available",
      });
    }

    emitBookingUpdate(booking);

    return res.json({
      success: true,
      message: "Job started",
      booking,
    });
  } catch (err) {
    console.error("IN_PROGRESS error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/**
 * =====================================================
 * PARTNER COMPLETE JOB
 * IN_PROGRESS → COMPLETED
 * =====================================================
 */
exports.markCompleted = async (req, res) => {
  // Safely map req.body.bookingId to req.params.bookingId so the booking.controller can digest it
  if (req.body.bookingId && !req.params.bookingId) {
    req.params.bookingId = req.body.bookingId;
  }
  return completeBooking(req, res);
};

/**
 * =====================================================
 * UPDATE PARTNER FCM TOKEN
 * =====================================================
 */
exports.updateFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (typeof fcmToken !== "string" || !fcmToken.trim()) {
      return res.status(400).json({
        success: false,
        message: "Valid fcmToken is required",
      });
    }

    const trimmedToken = fcmToken.trim();

    // A given FCM token belongs to exactly one device. If this token was
    // previously registered to another partner (e.g. a resold/reused phone),
    // detach it from them so pushes don't land on the wrong account.
    await Partner.updateMany(
      { fcmToken: trimmedToken, _id: { $ne: req.partner._id } },
      { $set: { fcmToken: "" } }
    );

    req.partner.fcmToken = trimmedToken;
    req.partner.lastOnlineAt = new Date();
    await req.partner.save();

    return res.json({
      success: true,
      message: "FCM token updated",
    });
  } catch (err) {
    console.error("updateFcmToken error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/**
 * =====================================================
 * UPDATE PARTNER LIVE LOCATION
 * =====================================================
 */
exports.updateLocation = async (req, res) => {
  try {
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({
        success: false,
        message: "Valid latitude and longitude are required",
      });
    }

    // Only call Google Maps Geocoding if partner has moved more than 500m
    // from the last geocoded position AND at least 5 minutes have elapsed
    // since their last geocode. This caps cost for partners moving continuously.
    const GEOCODE_THRESHOLD_M = 500;
    const GEOCODE_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    const lastGeocodedAt = req.partner.lastGeocodedAt
      ? new Date(req.partner.lastGeocodedAt).getTime()
      : 0;
    const geocodeCooledDown = Date.now() - lastGeocodedAt > GEOCODE_MIN_INTERVAL_MS;
    const prevCoords = req.partner.location?.coordinates;
    const hasPrev = Array.isArray(prevCoords) && prevCoords.length === 2
      && Number.isFinite(prevCoords[0]) && Number.isFinite(prevCoords[1])
      && (prevCoords[0] !== 0 || prevCoords[1] !== 0);

    let movedFarEnough = !hasPrev;
    if (hasPrev) {
      const [prevLng, prevLat] = prevCoords;
      const R = 6371000;
      const dLat = ((latitude - prevLat) * Math.PI) / 180;
      const dLng = ((longitude - prevLng) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((prevLat * Math.PI) / 180) *
          Math.cos((latitude * Math.PI) / 180) *
          Math.sin(dLng / 2) ** 2;
      const distanceMeters = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      movedFarEnough = distanceMeters > GEOCODE_THRESHOLD_M;
    }

    // Also geocode when the partner has no stored address/pincode (e.g. a past
    // geocode failure left them empty) — a stationary partner would otherwise
    // never re-trigger the >500m gate and stay blank forever.
    const missingGeocode = !req.partner.currentAddress || !req.partner.currentPincode;
    if ((movedFarEnough || missingGeocode) && geocodeCooledDown) {
      const resolved = await reverseGeocode(latitude, longitude, "partner_heartbeat");
      // Only overwrite on a successful geocode. On a Google outage/timeout we
      // keep the partner's last known pincode/address rather than wiping them to
      // empty, and we DON'T stamp lastGeocodedAt — so the next heartbeat retries
      // promptly instead of waiting out the 5-minute cooldown.
      if (resolved?.ok) {
        req.partner.currentPincode = resolved.pincode || "";
        req.partner.currentAddress = resolved.address || "";
        req.partner.lastGeocodedAt = new Date();
      }
    }

    req.partner.location = {
      type: "Point",
      coordinates: [longitude, latitude],
    };
    req.partner.h3Cell = deriveH3Cell(latitude, longitude);
    req.partner.lastLocationAt = new Date();
    req.partner.lastOnlineAt = new Date();
    await req.partner.save();

    // Emit partner live location for currently active user bookings.
    const activeBookings = await Booking.find({
      $or: [{ partner: req.partner._id }, { additionalPartners: req.partner._id }],
      status: {
        $in: ["CONFIRMED", "PARTNER_ACCEPTED", "ON_THE_WAY", "ARRIVED", "IN_PROGRESS"],
      },
    }).select("_id user");

    if (global.io && activeBookings.length) {
      activeBookings.forEach((booking) => {
        global.io.to(`user_${booking.user}`).emit("partner_location_update", {
          bookingId: booking._id.toString(),
          partnerId: req.partner._id.toString(),
          latitude,
          longitude,
          pincode: req.partner.currentPincode || "",
          address: req.partner.currentAddress || "",
          updatedAt: req.partner.lastLocationAt,
        });
      });
    }

    return res.json({
      success: true,
      message: "Partner location updated",
      location: req.partner.location,
      pincode: req.partner.currentPincode || "",
      address: req.partner.currentAddress || "",
      updatedAt: req.partner.lastLocationAt,
    });
  } catch (err) {
    console.error("updateLocation error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/**
 * =====================================================
 * GET SERVICES AVAILABLE FOR PARTNER CURRENT LOCATION
 * =====================================================
 */
exports.getAvailableServicesForLocation = async (req, res) => {
  try {
    const latitude =
      req.query.latitude !== undefined
        ? Number(req.query.latitude)
        : Number(req.partner?.location?.coordinates?.[1]);
    const longitude =
      req.query.longitude !== undefined
        ? Number(req.query.longitude)
        : Number(req.partner?.location?.coordinates?.[0]);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({
        success: false,
        message: "Valid latitude and longitude are required",
      });
    }

    const resolved = await reverseGeocode(latitude, longitude, "partner_available_svc");
    if (!resolved.ok) {
      return res.status(502).json({
        success: false,
        message: "Unable to validate location pincode",
      });
    }

    const pincode = String(resolved.pincode || "").trim();
    if (!pincode) {
      return res.status(400).json({
        success: false,
        message: "Unable to detect pincode for this location",
      });
    }

    const useH3 = await getUseH3Flag();
    let serviceArea;
    if (useH3) {
      serviceArea = await resolveHubForLocation(latitude, longitude);
    } else {
      serviceArea = await resolveZoneForPincode(pincode);
    }

    if (!serviceArea || serviceArea.isActive === false || serviceArea.partnerAppEnabled === false) {
      return res.json({
        success: true,
        pincode,
        address: resolved.address || "",
        services: [],
        message: "Partner app is disabled for this location",
      });
    }

    const activeSubCategories = await SubCategory.find({ isActive: true })
      .select("_id")
      .lean();
    const activeSubCategoryIds = activeSubCategories.map((item) => item._id);

    const services = await Service.find({
      isActive: true,
      $or: [
        { subCategory: { $exists: false } },
        { subCategory: null },
        { subCategory: { $in: activeSubCategoryIds } },
      ],
    })
      .populate("category")
      .populate("subCategory")
      .sort({ createdAt: -1 })
      .lean();

    // filterServicesByZone works for both zones and hubs — both have the same
    // services structure ({ acRepair, plumbing, mehendi, electrician }).
    const filteredServices = filterServicesByZone(services, serviceArea);

    return res.json({
      success: true,
      pincode,
      address: resolved.address || "",
      count: filteredServices.length,
      services: filteredServices,
    });
  } catch (err) {
    console.error("getAvailableServicesForLocation error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/**
 * =====================================================
 * UPLOAD MY SELFIE
 * Sets the partner's reference selfie (onboarding photo) used for
 * job-spot verification and admin approval review.
 * =====================================================
 */
exports.uploadMySelfie = async (req, res) => {
  try {
    if (!req.partner?._id) {
      return res.status(401).json({ success: false, message: "Partner auth required" });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Selfie image is required" });
    }

    // Cloudinary storage puts the hosted URL in file.path; local storage needs
    // the public /uploads URL built (same pattern as uploadController.js).
    const filePath = String(req.file.path || "");
    const isRemote = filePath.startsWith("http://") || filePath.startsWith("https://");
    const configuredBaseUrl = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
    const selfieUrl = isRemote
      ? filePath
      : configuredBaseUrl
        ? `${configuredBaseUrl}/uploads/${req.file.filename}`
        : `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    req.partner.selfieUrl = selfieUrl;
    await req.partner.save();

    return res.json({ success: true, selfieUrl });
  } catch (err) {
    console.error("uploadMySelfie error:", err);
    return res.status(500).json({ success: false, message: "Failed to upload selfie" });
  }
};

exports.getPartnerAppSettings = async (_req, res) => {
  try {
    const settings = await require("../admin/models/AdminSetting").findOne().lean();

    return res.json({
      success: true,
      partnerSubscriptionRequired: Boolean(settings?.partnerSubscriptionRequired),
      partnerVerificationRequired: Boolean(settings?.partnerVerificationRequired),
      partnerSelfieRequired: Boolean(settings?.partnerSelfieRequired),
      jobSelfieVerificationEnabled: Boolean(settings?.jobSelfieVerificationEnabled),
      arrivedCancelPenaltyInr: Number(settings?.cancellation?.arrivedCancelPenaltyInr ?? 100),
    });
  } catch (err) {
    console.error("getPartnerAppSettings error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/**
 * =====================================================
 * GET PARTS CATALOG
 * Returns all active services with admin-set prices.
 * Partner uses this to build an itemized estimate.
 * =====================================================
 */
exports.getPartsCatalog = async (req, res) => {
  try {
    const items = await CatalogItem.find({ isActive: true })
      .select("_id name priceInr unit description")
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    // Map priceInr → price so the partner app receives a consistent shape
    const services = items.map((i) => ({
      _id: i._id,
      name: i.name,
      price: i.priceInr,
      unit: i.unit || "piece",
      description: i.description,
    }));

    return res.json({ success: true, count: services.length, services });
  } catch (err) {
    console.error("getPartsCatalog error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * =====================================================
 * SUBMIT ITEMIZED ESTIMATE
 * Partner sends a list of {serviceId, quantity} items.
 * Prices are fetched from DB (admin-set), frozen into
 * the booking, and the customer is notified via socket.
 * =====================================================
 */
exports.submitEstimate = async (req, res) => {
  try {
    const partnerId = req.partner._id;
    const { bookingId, items } = req.body;

    if (!bookingId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "bookingId and a non-empty items array are required",
      });
    }

    const booking = await Booking.findOne({
      _id: bookingId,
      $or: [{ partner: partnerId }, { additionalPartners: partnerId }],
      status: { $in: ["CONFIRMED", "PARTNER_ACCEPTED", "ON_THE_WAY", "IN_PROGRESS"] },
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found or not accessible for this partner",
      });
    }

    // Block re-submission after the customer has already responded. Allowed
    // states are "none" (first estimate) and "pending" (correcting an estimate
    // the customer hasn't acted on yet). Without this guard, a partner could
    // spam new estimates after a rejection.
    const currentEstimateStatus = String(booking.estimateStatus || "none");
    if (currentEstimateStatus === "approved") {
      return res.status(409).json({
        success: false,
        message: "An estimate has already been approved for this booking",
      });
    }
    if (currentEstimateStatus === "rejected") {
      return res.status(409).json({
        success: false,
        message:
          "The previous estimate was rejected by the customer. Contact support if you need to revise the scope.",
      });
    }

    // Fetch live prices from CatalogItem (admin-set) so price changes are always respected
    const itemIds = items.map((i) => i.serviceId).filter(Boolean);
    const catalogItems = await CatalogItem.find({
      _id: { $in: itemIds },
      isActive: true,
    }).lean();
    const catalogMap = Object.fromEntries(
      catalogItems.map((c) => [c._id.toString(), c])
    );

    const estimateItems = [];
    let estimateTotal = 0;

    for (const item of items) {
      const catalogItem = catalogMap[String(item.serviceId)];
      if (!catalogItem) continue;
      const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
      const lineTotal = Math.round(catalogItem.priceInr * qty * 100) / 100;
      estimateItems.push({
        serviceId: catalogItem._id,
        name: catalogItem.name,
        price: catalogItem.priceInr,
        quantity: qty,
        lineTotal,
      });
      estimateTotal += lineTotal;
    }

    if (estimateItems.length === 0) {
      return res.status(400).json({
        success: false,
        message: "None of the provided service IDs are active",
      });
    }

    estimateTotal = Math.round(estimateTotal * 100) / 100;

    booking.estimateItems = estimateItems;
    booking.estimateTotal = estimateTotal;
    booking.estimateStatus = "pending";
    booking.estimateSubmittedAt = new Date();
    booking.estimateApprovedAt = null;
    booking.estimateRejectedAt = null;
    await booking.save();

    // Notify customer in real time so they can approve/reject
    if (global.io) {
      global.io.to(`user_${booking.user}`).emit("estimate_submitted", {
        bookingId: booking._id.toString(),
        estimateItems,
        estimateTotal,
        submittedAt: booking.estimateSubmittedAt,
      });
    }

    return res.json({
      success: true,
      message: "Estimate sent to customer for approval",
      estimateItems,
      estimateTotal,
    });
  } catch (err) {
    console.error("submitEstimate error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getPartnerBookings = async (req, res) => {
  try {
    const partnerId = req.partner?._id;
    if (!partnerId) {
      return res.status(401).json({
        success: false,
        message: "Partner auth required",
      });
    }

    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip  = (page - 1) * limit;

    const now = new Date();
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    // Booking IDs with open disputes involving this partner — shown regardless of age
    const disputedBookingIds = await Dispute.distinct("bookingId", {
      partnerId,
      status: { $in: ["OPEN", "IN_REVIEW"] },
    });

    const partnerConditions = [
      { partner: partnerId },
      { additionalPartners: partnerId },
      { "partnerCancellations.partner": partnerId },
    ];

    const query = {
      $or: [
        // Normal history: last 60 days only
        {
          $or: partnerConditions,
          status: {
            $in: [
              "ASSIGNED", "CONFIRMED", "PARTNER_ACCEPTED",
              "ON_THE_WAY", "ARRIVED", "IN_PROGRESS",
              "COMPLETED", "CANCELLED",
            ],
          },
          createdAt: { $gte: sixtyDaysAgo },
        },
        // Disputed bookings: keep regardless of age, until dispute is resolved
        ...(disputedBookingIds.length
          ? [{ _id: { $in: disputedBookingIds }, $or: partnerConditions }]
          : []),
      ],
    };

    const [bookingDocs, total] = await Promise.all([
      Booking.find(query)
        .populate("user", "name phone")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Booking.countDocuments(query),
    ]);

    const payloads = [];
    for (const booking of bookingDocs) {
      try {
        const isPartnerCancelled = Array.isArray(booking.partnerCancellations) &&
          booking.partnerCancellations.some(
            (c) => c.partner?.toString() === partnerId.toString()
          );
        payloads.push(toPartnerJobPayload(booking, partnerId, { isPartnerCancelled }));
      } catch (itemErr) {
        console.error("getPartnerBookings item error:", {
          bookingId: booking?._id?.toString?.() || String(booking?._id || ""),
          message: itemErr.message,
        });
      }
    }

    return res.json({
      success: true,
      count: payloads.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      bookings: payloads,
    });
  } catch (err) {
    console.error("getPartnerBookings error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/**
 * Delete partner account (soft delete — anonymise PII)
 * Blocked if partner has an active job in progress.
 * DELETE /api/partner/me
 */
exports.deletePartnerAccount = async (req, res) => {
  try {
    const partnerId = req.partner?._id;
    if (!partnerId) {
      return res.status(401).json({ success: false, message: "Partner auth required" });
    }

    const partner = await Partner.findById(partnerId);
    if (!partner) {
      return res.status(404).json({ success: false, message: "Partner not found" });
    }
    if (partner.isDeleted) {
      return res.status(400).json({ success: false, message: "Account already deleted" });
    }

    // Block if an active job exists
    const activeJobStatuses = [
      "ASSIGNED",
      "CONFIRMED",
      "PARTNER_ACCEPTED",
      "ON_THE_WAY",
      "ARRIVED",
      "IN_PROGRESS",
    ];
    const activeJob = await Booking.findOne({
      $or: [{ partner: partnerId }, { additionalPartners: partnerId }],
      status: { $in: activeJobStatuses },
    }).lean();

    if (activeJob) {
      return res.status(400).json({
        success: false,
        code: "ACTIVE_JOB",
        message: "You have an active job in progress. Please complete it before deleting your account.",
      });
    }

    const { reason = "" } = req.body;

    partner.name = "Deleted Partner";
    partner.phone = `deleted_${partnerId}`;
    partner.email = "";
    partner.fcmToken = "";
    partner.isBlocked = true;
    partner.isDeleted = true;
    partner.deletedAt = new Date();
    partner.deleteReason = reason;
    await partner.save();

    res.json({ success: true, message: "Account deleted successfully" });
  } catch (err) {
    console.error("deletePartnerAccount error:", err);
    res.status(500).json({ success: false, message: "Failed to delete account" });
  }
};
