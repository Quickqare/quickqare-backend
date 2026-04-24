const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");
const SubCategory = require("../models/SubCategory");
const Zone = require("../models/zone.model");
const { reverseGeocode } = require("../services/geocode.service");
const { syncPartnerOperationalState } = require("../services/scheduling.service");
const { emitBookingUpdate } = require("../socket/emitters");
const { completeBooking } = require("./booking.controller");

function toPartnerJobPayload(booking, partnerId) {
  const firstService = booking?.services?.[0] || {};
  const firstServiceName =
    firstService?.name || booking?.serviceCategory || "Service";
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
    const allocations = booking.get("teamAllocations") || [];
    const myAllocation = allocations.find(a => a.partnerId?.toString() === partnerId.toString());
    if (allocations.length > 1) isTeamJob = true;
    if (myAllocation) {
      amount = Number((amount * (myAllocation.payoutRatio || 1)).toFixed(2));
      isPrimary = Boolean(myAllocation.isPrimary);
    }
  }

  return {
    id: String(booking?._id || ""),
    bookingId: String(booking?._id || ""),
    serviceName: String(firstServiceName),
    serviceCategory: booking?.serviceCategory || firstService?.category || "general",
    customerName: booking?.user?.name || "Customer",
    customerPhone: booking?.user?.phone || "",
    address: booking?.address || booking?.pincode || "",
    pincode: booking?.pincode ? String(booking.pincode) : "",
    customerLatitude: Number.isFinite(customerLatitude) ? customerLatitude : null,
    customerLongitude: Number.isFinite(customerLongitude) ? customerLongitude : null,
    amount,
    price: amount,
    isTeamJob,
    isPrimary,
    scheduledDate: booking?.scheduledDate || null,
    scheduledTime: booking?.scheduledTime || "",
    status: booking?.status || "ASSIGNED",
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

    req.partner.fcmToken = fcmToken.trim();
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

    const resolved = await reverseGeocode(latitude, longitude);

    req.partner.location = {
      type: "Point",
      coordinates: [longitude, latitude],
    };
    req.partner.currentPincode = resolved?.ok ? resolved.pincode || "" : "";
    req.partner.currentAddress = resolved?.ok ? resolved.address || "" : "";
    req.partner.lastLocationAt = new Date();
    req.partner.lastOnlineAt = new Date();
    await req.partner.save();

    // Emit partner live location for currently active user bookings.
    const activeBookings = await Booking.find({
      $or: [{ partner: req.partner._id }, { additionalPartners: req.partner._id }],
      status: {
        $in: ["CONFIRMED", "PARTNER_ACCEPTED", "ON_THE_WAY", "IN_PROGRESS"],
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

    const resolved = await reverseGeocode(latitude, longitude);
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

    const zone = await Zone.findOne({ pincode }).lean();
    if (zone && (zone.isActive === false || zone.partnerAppEnabled === false)) {
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

    return res.json({
      success: true,
      pincode,
      address: resolved.address || "",
      count: services.length,
      services,
    });
  } catch (err) {
    console.error("getAvailableServicesForLocation error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
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
    });
  } catch (err) {
    console.error("getPartnerAppSettings error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

exports.getPartnerBookings = async (req, res) => {
  try {
    const partnerId = req.partner?._id;

    const bookings = await Booking.find({
      $or: [{ partner: partnerId }, { additionalPartners: partnerId }],
      status: {
        $in: [
          "ASSIGNED",
          "CONFIRMED",
          "PARTNER_ACCEPTED",
          "ON_THE_WAY",
          "IN_PROGRESS",
          "COMPLETED",
        ],
      },
    })
      .populate("user", "name phone")
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      count: bookings.length,
      bookings: bookings.map(b => toPartnerJobPayload(b, partnerId)),
    });
  } catch (err) {
    console.error("getPartnerBookings error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};
