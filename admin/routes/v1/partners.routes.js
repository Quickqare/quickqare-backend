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
    const [wallets, completedRows] = await Promise.all([
      PartnerWallet.find({ partnerId: { $in: partnerIds } }).lean(),
      Booking.aggregate([
        { $match: { partner: { $in: partnerIds }, status: "COMPLETED" } },
        { $group: { _id: "$partner", completedJobs: { $sum: 1 } } },
      ]),
    ]);

    const walletMap = new Map(wallets.map((w) => [String(w.partnerId), w]));
    const completedMap = new Map(completedRows.map((r) => [String(r._id), r.completedJobs]));

    const data = partners.map((partner) => ({
      id: String(partner._id),
      name: partner.name,
      phone: partner.phone,
      serviceCategory: partner.serviceCategories?.[0] || "",
      status: partner.isBlocked ? "BLOCKED" : partner.approvalStatus || "PENDING",
      rating: partner.rating || 0,
      totalEarnings: walletMap.get(String(partner._id))?.totalEarnings || 0,
      completedJobs: completedMap.get(String(partner._id)) || 0,
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
