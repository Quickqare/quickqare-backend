const express = require("express");
const mongoose = require("mongoose");
const Partner = require("../../../models/Partner");
const Booking = require("../../../models/Booking");
const PartnerWallet = require("../../../models/PartnerWallet");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { asSingleString, getPagination } = require("../../utils/common");
const { success, fail } = require("../../utils/response");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.PARTNERS_APPROVE));

const ACTIVE_STATUSES = ["ASSIGNED", "CONFIRMED", "PARTNER_ACCEPTED", "ON_THE_WAY", "ARRIVED", "IN_PROGRESS"];

router.get("/", async (req, res) => {
  try {
    const status = String(asSingleString(req.query.status) || "").toUpperCase();
    const { page, pageSize, skip, limit } = getPagination(req);

    const where = {};
    if (status === "PENDING" || status === "APPROVED" || status === "REJECTED") {
      where.approvalStatus = status;
    }
    if (status === "BLOCKED") {
      where.isBlocked = true;
    }

    const [partners, total] = await Promise.all([
      Partner.find(where).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Partner.countDocuments(where),
    ]);

    const partnerIds = partners.map((p) => p._id);
    const [wallets, completedRows, pendingRows] = await Promise.all([
      PartnerWallet.find({ partnerId: { $in: partnerIds } }).lean(),
      Booking.aggregate([
        { $match: { partner: { $in: partnerIds }, status: "COMPLETED" } },
        { $group: { _id: "$partner", completedJobs: { $sum: 1 } } },
      ]),
      Booking.aggregate([
        { $match: { partner: { $in: partnerIds }, status: { $in: ACTIVE_STATUSES } } },
        { $group: { _id: "$partner", pendingJobs: { $sum: 1 } } },
      ]),
    ]);

    const walletMap = new Map(wallets.map((w) => [String(w.partnerId), w]));
    const completedMap = new Map(completedRows.map((r) => [String(r._id), r.completedJobs]));
    const pendingMap = new Map(pendingRows.map((r) => [String(r._id), r.pendingJobs]));

    const data = partners.map((partner) => ({
      id: String(partner._id),
      name: partner.name,
      phone: partner.phone,
      serviceCategory: partner.serviceCategories?.[0] || "",
      pincode: partner.currentPincode || "",
      status: partner.isBlocked ? "BLOCKED" : partner.approvalStatus || "PENDING",
      rating: partner.rating || 0,
      totalEarnings: walletMap.get(String(partner._id))?.totalEarnings || 0,
      completedJobs: completedMap.get(String(partner._id)) || 0,
      pendingJobs: pendingMap.get(String(partner._id)) || 0,
      activeJobs: partner.activeJobs || 0,
      maxJobsLimit: partner.maxJobsLimit || 3,
      isOnline: Boolean(partner.isOnline),
      commissionPercent: partner.commissionPercent ?? 20,
      subscriptionActive: Boolean(partner.subscriptionActive),
    }));

    return success(res, data, { requestId: req.requestId, pagination: { page, pageSize, total } });
  } catch (error) {
    return fail(res, 500, "PARTNERS_LIST_FAILED", "Unable to fetch partners", error.message, {
      requestId: req.requestId,
    });
  }
});

// GET /available — partners eligible for reassignment, optionally filtered by pincode
router.get("/available", async (req, res) => {
  try {
    const pincode = String(req.query.pincode || "").trim();
    const bookingId = String(req.query.bookingId || "").trim();

    let excludePartnerId = null;
    if (bookingId && mongoose.Types.ObjectId.isValid(bookingId)) {
      const bk = await Booking.findById(bookingId).select("partner").lean();
      excludePartnerId = bk?.partner;
    }

    const where = { approvalStatus: "APPROVED", isBlocked: false };
    if (pincode) {
      where.$or = [{ currentPincode: pincode }, { serviceAreas: pincode }];
    }
    if (excludePartnerId) {
      where._id = { $ne: excludePartnerId };
    }

    const partners = await Partner.find(where)
      .select("name phone rating activeJobs maxJobsLimit currentPincode serviceAreas isOnline lastLocationAt lastAssignedAt")
      .sort({ activeJobs: 1, rating: -1 })
      .limit(50)
      .lean();

    return success(res, partners, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "AVAILABLE_PARTNERS_FAILED", "Unable to fetch available partners", error.message, { requestId: req.requestId });
  }
});

// GET /:id/stats — full stats for the detail panel
router.get("/:id/stats", async (req, res) => {
  try {
    const partnerId = asSingleString(req.params.id);
    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid partner id", null, { requestId: req.requestId });
    }

    const partner = await Partner.findById(partnerId)
      .select("name phone email rating activeJobs maxJobsLimit currentPincode serviceAreas serviceCategories isOnline approvalStatus isBlocked plan commissionPercent subscriptionActive createdAt")
      .lean();
    if (!partner) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    const pid = new mongoose.Types.ObjectId(partnerId);
    const [totalJobs, pendingJobs, completedJobs, earningsAgg, wallet, activeBookings] = await Promise.all([
      Booking.countDocuments({ partner: pid, status: { $nin: ["PENDING_PAYMENT", "CANCELLED"] } }),
      Booking.countDocuments({ partner: pid, status: { $in: ACTIVE_STATUSES } }),
      Booking.countDocuments({ partner: pid, status: "COMPLETED" }),
      Booking.aggregate([
        { $match: { partner: pid, status: "COMPLETED" } },
        { $group: { _id: null, total: { $sum: "$partnerSettlement.partnerEarningAmount" } } },
      ]),
      PartnerWallet.findOne({ partnerId }).select("totalEarnings pendingEarnings").lean(),
      Booking.find({ partner: pid, status: { $in: ACTIVE_STATUSES } })
        .select("bookingNumber status scheduledDate scheduledTime totalAmount pincode address services")
        .sort({ scheduledDate: 1 })
        .limit(20)
        .lean(),
    ]);

    return success(res, {
      partner,
      stats: {
        totalJobs,
        pendingJobs,
        completedJobs,
        totalEarnings: earningsAgg[0]?.total || 0,
        walletBalance: wallet?.pendingEarnings || 0,
        walletTotalEarnings: wallet?.totalEarnings || 0,
      },
      activeBookings,
    }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "PARTNER_STATS_FAILED", "Unable to fetch partner stats", error.message, { requestId: req.requestId });
  }
});

// GET /:id/location — on-demand live location (never auto-fetched for privacy)
router.get("/:id/location", async (req, res) => {
  try {
    const partnerId = asSingleString(req.params.id);
    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid partner id", null, { requestId: req.requestId });
    }

    const partner = await Partner.findById(partnerId)
      .select("name isOnline location currentPincode currentAddress lastLocationAt")
      .lean();
    if (!partner) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    return success(res, {
      isOnline: partner.isOnline,
      location: partner.location,
      currentPincode: partner.currentPincode,
      currentAddress: partner.currentAddress,
      lastLocationAt: partner.lastLocationAt,
    }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "PARTNER_LOCATION_FAILED", "Unable to fetch partner location", error.message, { requestId: req.requestId });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const partnerId = asSingleString(req.params.id);
    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid partner id", null, { requestId: req.requestId });
    }

    const [partner, wallet, recentBookings] = await Promise.all([
      Partner.findById(partnerId).lean(),
      PartnerWallet.findOne({ partnerId }).lean(),
      Booking.find({ partner: partnerId }).sort({ createdAt: -1 }).limit(50).lean(),
    ]);

    if (!partner) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    return success(
      res,
      {
        ...partner,
        wallet,
        recentBookings,
      },
      { requestId: req.requestId }
    );
  } catch (error) {
    return fail(res, 500, "PARTNER_FETCH_FAILED", "Unable to fetch partner", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/:id/approval", audit("admin.partners.approval"), async (req, res) => {
  try {
    const partnerId = asSingleString(req.params.id);
    const status = String(req.body.status || "").toUpperCase();
    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid partner id", null, { requestId: req.requestId });
    }
    if (!["APPROVED", "REJECTED"].includes(status)) {
      return fail(res, 400, "VALIDATION_ERROR", "status must be APPROVED or REJECTED", null, {
        requestId: req.requestId,
      });
    }

    const updated = await Partner.findByIdAndUpdate(
      partnerId,
      {
        $set: {
          approvalStatus: status,
          verificationStatus: status === "APPROVED" ? "VERIFIED" : "REJECTED",
          isBlocked: false,
        },
      },
      { new: true }
    ).lean();

    if (!updated) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    return success(res, updated, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "PARTNER_APPROVAL_FAILED", "Unable to update partner approval", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/:id/status", audit("admin.partners.status"), async (req, res) => {
  try {
    const partnerId = asSingleString(req.params.id);
    const status = String(req.body.status || "").toUpperCase();
    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid partner id", null, { requestId: req.requestId });
    }
    if (!["PENDING", "APPROVED", "BLOCKED", "REJECTED"].includes(status)) {
      return fail(res, 400, "VALIDATION_ERROR", "Invalid partner status", null, {
        requestId: req.requestId,
      });
    }

    const updated = await Partner.findByIdAndUpdate(
      partnerId,
      {
        $set: {
          approvalStatus: status === "BLOCKED" ? "APPROVED" : status,
          isBlocked: status === "BLOCKED",
        },
      },
      { new: true }
    ).lean();

    if (!updated) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    return success(res, updated, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "PARTNER_STATUS_FAILED", "Unable to update partner status", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/:id/commission", audit("admin.partners.commission"), async (req, res) => {
  try {
    const partnerId = asSingleString(req.params.id);
    const commissionPercent = Number(req.body.commissionPercent);
    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid partner id", null, { requestId: req.requestId });
    }
    if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
      return fail(res, 400, "VALIDATION_ERROR", "commissionPercent must be between 0 and 100", null, {
        requestId: req.requestId,
      });
    }

    const updated = await Partner.findByIdAndUpdate(
      partnerId,
      { $set: { commissionPercent } },
      { new: true }
    ).lean();
    if (!updated) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    return success(res, updated, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "PARTNER_COMMISSION_FAILED", "Unable to update partner commission", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/:id/subscription", audit("admin.partners.subscription"), async (req, res) => {
  try {
    const partnerId = asSingleString(req.params.id);
    const subscriptionActive = Boolean(req.body.subscriptionActive);
    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid partner id", null, { requestId: req.requestId });
    }

    const updated = await Partner.findByIdAndUpdate(
      partnerId,
      { $set: { subscriptionActive } },
      { new: true }
    ).lean();
    if (!updated) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    return success(res, updated, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "PARTNER_SUBSCRIPTION_FAILED", "Unable to update partner subscription", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
