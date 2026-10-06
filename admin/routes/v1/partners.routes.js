const express = require("express");
const mongoose = require("mongoose");
const Partner = require("../../../models/Partner");
const Booking = require("../../../models/Booking");
const PartnerWallet = require("../../../models/PartnerWallet");
const PartnerPayoutAccount = require("../../../models/PartnerPayoutAccount");
const Withdrawal = require("../../../models/Withdrawal");
const Hub = require("../../../models/Hub");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { asSingleString, getPagination, escapeRegex } = require("../../utils/common");
const { success, fail } = require("../../utils/response");
const { getSensitiveFileUrl } = require("../../../utils/sensitiveFileUrl");
const { trackApiCall } = require("../../../services/apiCallTracker.service");

// Approving / unblocking a partner restores them fully: an auto-suspension
// (5 weekly strikes) leaves isAvailable=false + suspendedUntil, which kept an
// unblocked partner out of every assignment and slot. The admin's decision
// also starts their cancel counters afresh.
const RESTORE_AVAILABILITY = Object.freeze({
  isAvailable: true,
  suspendedUntil: null,
  weeklyCancelCount: 0,
  dailyCancelCount: 0,
});

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.PARTNERS_APPROVE));

const ACTIVE_STATUSES = ["ASSIGNED", "CONFIRMED", "PARTNER_ACCEPTED", "ON_THE_WAY", "ARRIVED", "IN_PROGRESS"];

router.get("/", async (req, res) => {
  try {
    const status = String(asSingleString(req.query.status) || "").toUpperCase();
    const { page, pageSize, skip, limit } = getPagination(req);

    // Deleted accounts (by the partner or by an admin) are anonymised shells
    // kept only for their booking and wallet history — not listed.
    const where = { isDeleted: { $ne: true } };
    if (status === "PENDING" || status === "APPROVED" || status === "REJECTED") {
      where.approvalStatus = status;
    }
    if (status === "BLOCKED") {
      where.isBlocked = true;
    }

    const q = String(asSingleString(req.query.q) || "").trim();
    if (q) {
      const qSafe = escapeRegex(q);
      where.$or = [
        { name:  { $regex: qSafe, $options: "i" } },
        { phone: { $regex: qSafe, $options: "i" } },
        { email: { $regex: qSafe, $options: "i" } },
      ];
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
      gender: partner.gender || "",
      serviceCategory: partner.serviceCategories?.[0] || "",
      skillTier: partner.skillTier || 1,
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

// GET /live-locations — all approved partners with their latest location data
router.get("/live-locations", async (req, res) => {
  try {
    const partners = await Partner.find({ approvalStatus: "APPROVED", isBlocked: false })
      .select("name phone isOnline isAvailable location currentPincode currentAddress lastLocationAt activeJobs rating")
      .lean();

    const now = Date.now();
    const FRESH_MS = 5 * 60 * 1000; // 5 minutes

    trackApiCall("admin_live_tracking", { cacheHit: false });
    const data = partners.map((p) => {
      const coords = p.location?.coordinates;
      const hasLocation = Array.isArray(coords) && (coords[0] !== 0 || coords[1] !== 0);
      const lastAt = p.lastLocationAt ? new Date(p.lastLocationAt).getTime() : 0;
      const isFresh = lastAt > 0 && (now - lastAt) <= FRESH_MS;

      return {
        id: String(p._id),
        name: p.name,
        phone: p.phone,
        isOnline: Boolean(p.isOnline),
        isAvailable: Boolean(p.isAvailable),
        activeJobs: p.activeJobs || 0,
        rating: p.rating || 0,
        latitude: hasLocation ? coords[1] : null,
        longitude: hasLocation ? coords[0] : null,
        currentPincode: p.currentPincode || "",
        currentAddress: p.currentAddress || "",
        lastLocationAt: p.lastLocationAt || null,
        locationFresh: isFresh,
      };
    });

    return success(res, data, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "LIVE_LOCATIONS_FAILED", "Unable to fetch live locations", error.message, { requestId: req.requestId });
  }
});

// POST /request-locations — push a socket ping to all online partners asking for their current GPS
router.post("/request-locations", async (req, res) => {
  try {
    if (!global.io) {
      return fail(res, 503, "SOCKET_UNAVAILABLE", "Real-time server not available", null, { requestId: req.requestId });
    }

    const onlinePartners = await Partner.find({ approvalStatus: "APPROVED", isBlocked: false, isOnline: true })
      .select("_id")
      .lean();

    trackApiCall("admin_location_ping", { cacheHit: false });
    let pinged = 0;
    for (const p of onlinePartners) {
      global.io.to(`partner_${p._id}`).emit("request_location_update", {
        requestedAt: new Date().toISOString(),
      });
      pinged++;
    }

    return success(res, { pinged }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "REQUEST_LOCATIONS_FAILED", "Unable to request location updates", error.message, { requestId: req.requestId });
  }
});

// GET /available — partners eligible for reassignment, optionally filtered by pincode
router.get("/available", async (req, res) => {
  try {
    const pincode = String(req.query.pincode || "").trim();
    const bookingId = String(req.query.bookingId || "").trim();

    let excludePartnerId = null;
    let genderRule = null;
    if (bookingId && mongoose.Types.ObjectId.isValid(bookingId)) {
      const bk = await Booking.findById(bookingId)
        .select("partner services serviceId serviceCategory")
        .lean();
      excludePartnerId = bk?.partner;
      // Offer only partners the booking's category partner-gender rule allows
      // — /bookings/:id/reassign rejects anyone else.
      if (bk) {
        const { getPartnerGenderRule } = require("../../../services/scheduling_service");
        genderRule = await getPartnerGenderRule(bk);
      }
    }
    if (genderRule?.conflict) {
      return success(res, [], { requestId: req.requestId });
    }

    const where = { approvalStatus: "APPROVED", isBlocked: false };
    if (pincode) {
      where.$or = [{ currentPincode: pincode }, { serviceAreas: pincode }];
    }
    if (excludePartnerId) {
      where._id = { $ne: excludePartnerId };
    }
    if (genderRule?.required) {
      where.gender = genderRule.required;
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
      .select("name phone email gender rating activeJobs maxJobsLimit currentPincode serviceAreas serviceCategories skillTier isOnline approvalStatus isBlocked plan commissionPercent subscriptionActive createdAt location assignedHubId mehendiSpecializations selfieUrl selfieVerificationStatus selfieRejectionReason services")
      .populate("assignedHubId", "name city state")
      .lean();
    if (!partner) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    // Sign the selfie URL for admin review when private uploads are enabled
    // (no-op otherwise). The selfie is identity data, not public media.
    if (partner.selfieUrl) partner.selfieUrl = await getSensitiveFileUrl(partner.selfieUrl);

    const pid = new mongoose.Types.ObjectId(partnerId);
    const [totalJobs, pendingJobs, completedJobs, earningsAgg, wallet, activeBookings] = await Promise.all([
      Booking.countDocuments({ partner: pid, status: { $nin: ["PENDING_PAYMENT", "CANCELLED"] } }),
      Booking.countDocuments({ partner: pid, status: { $in: ACTIVE_STATUSES } }),
      Booking.countDocuments({ partner: pid, status: "COMPLETED" }),
      Booking.aggregate([
        { $match: { partner: pid, status: "COMPLETED" } },
        { $group: { _id: null, total: { $sum: "$partnerSettlement.partnerEarningAmount" } } },
      ]),
      PartnerWallet.findOne({ partnerId }).select("totalEarnings withdrawableBalance pendingBalance balance").lean(),
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
        // Everything the wallet holds for the partner: what they can withdraw
        // now plus earnings not yet released. (This read `pendingEarnings`, a
        // field the wallet never had, so it always showed 0.)
        walletBalance:
          Math.round(
            (Number(wallet?.withdrawableBalance ?? wallet?.balance ?? 0) + Number(wallet?.pendingBalance || 0)) * 100
          ) / 100,
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

    trackApiCall("admin_partner_location", { cacheHit: false });
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

router.patch("/:id/selfie-verification", audit("admin.partners.selfie_verification"), async (req, res) => {
  try {
    const partnerId = asSingleString(req.params.id);
    const status = String(req.body.status || "").toUpperCase();
    const reason = String(req.body.reason || "").trim();

    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid partner id", null, { requestId: req.requestId });
    }
    if (!["APPROVED", "REJECTED"].includes(status)) {
      return fail(res, 400, "VALIDATION_ERROR", "status must be APPROVED or REJECTED", null, { requestId: req.requestId });
    }
    if (status === "REJECTED" && !reason) {
      return fail(res, 400, "VALIDATION_ERROR", "reason is required when rejecting a selfie", null, { requestId: req.requestId });
    }

    const updated = await Partner.findByIdAndUpdate(
      partnerId,
      {
        $set: {
          selfieVerificationStatus: status,
          selfieRejectionReason: status === "REJECTED" ? reason : "",
        },
      },
      { new: true }
    ).select("name selfieUrl selfieVerificationStatus selfieRejectionReason").lean();

    if (!updated) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    if (updated.selfieUrl) updated.selfieUrl = await getSensitiveFileUrl(updated.selfieUrl);

    // Notify partner via socket if connected
    if (global.io) {
      global.io.to(`partner_${partnerId}`).emit("selfie_verification_update", {
        selfieVerificationStatus: status,
        selfieRejectionReason: status === "REJECTED" ? reason : "",
      });
    }

    return success(res, updated, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "SELFIE_VERIFICATION_FAILED", "Unable to update selfie verification", error.message, { requestId: req.requestId });
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
          ...(status === "APPROVED" ? RESTORE_AVAILABILITY : {}),
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
          ...(status !== "BLOCKED" ? RESTORE_AVAILABILITY : {}),
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

// Correct a partner's registered gender (e.g. a legacy signup from before
// gender was required). Categories with a partnerGender rule only match
// partners whose gender is set to that value.
router.patch("/:id/gender", audit("admin.partners.gender"), async (req, res) => {
  try {
    const partnerId = asSingleString(req.params.id);
    const gender = String(req.body.gender || "").trim().toUpperCase();
    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid partner id", null, { requestId: req.requestId });
    }
    if (!["MALE", "FEMALE", "OTHER"].includes(gender)) {
      return fail(res, 400, "VALIDATION_ERROR", "gender must be MALE, FEMALE or OTHER", null, {
        requestId: req.requestId,
      });
    }

    const updated = await Partner.findByIdAndUpdate(
      partnerId,
      { $set: { gender } },
      { new: true }
    ).lean();
    if (!updated) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    return success(res, updated, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "PARTNER_GENDER_FAILED", "Unable to update partner gender", error.message, {
      requestId: req.requestId,
    });
  }
});

// Set a partner's skill tier. AC: 1 = serviceman, 2 = technician (also set
// by the partner at signup). Salon / self-care: 1 = beautician, 2 = senior
// beautician — admin-set only, the partner app never asks. Services marked
// tier 2 are only assigned to tier-2 partners.
router.patch("/:id/skill-tier", audit("admin.partners.skillTier"), async (req, res) => {
  try {
    const partnerId = asSingleString(req.params.id);
    const skillTier = Number(req.body.skillTier);
    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid partner id", null, { requestId: req.requestId });
    }
    if (![1, 2].includes(skillTier)) {
      return fail(res, 400, "VALIDATION_ERROR", "skillTier must be 1 or 2", null, {
        requestId: req.requestId,
      });
    }

    const updated = await Partner.findByIdAndUpdate(
      partnerId,
      { $set: { skillTier } },
      { new: true }
    )
      .select("_id name skillTier serviceCategories")
      .lean();
    if (!updated) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    return success(res, updated, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "PARTNER_SKILL_TIER_FAILED", "Unable to update partner skill tier", error.message, {
      requestId: req.requestId,
    });
  }
});

/* ── Assign Hub to partner ──────────────────────────────────────────────── */
router.patch("/:id/hub", audit("admin.partners.hub"), async (req, res) => {
  try {
    const partnerId = asSingleString(req.params.id);
    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid partner id", null, { requestId: req.requestId });
    }

    const { hubId } = req.body;

    // Allow clearing the assignment by passing null
    if (hubId !== null && hubId !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(String(hubId))) {
        return fail(res, 400, "VALIDATION_ERROR", "Invalid hub id", null, { requestId: req.requestId });
      }
      const hub = await Hub.findById(hubId).select("_id").lean();
      if (!hub) {
        return fail(res, 404, "HUB_NOT_FOUND", "Hub not found", null, { requestId: req.requestId });
      }
    }

    const partner = await Partner.findByIdAndUpdate(
      partnerId,
      { $set: { assignedHubId: hubId || null } },
      { new: true }
    ).select("name assignedHubId").populate("assignedHubId", "name city").lean();

    if (!partner) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    return success(res, partner, { requestId: req.requestId });
  } catch (err) {
    return fail(res, 500, "HUB_ASSIGN_FAILED", "Unable to assign hub", err.message, { requestId: req.requestId });
  }
});

// Deleting a partner is a soft delete, the same shape as the partner's own
// "delete my account" (controllers/partner.controller.js): PII is anonymised
// and the phone number is freed for a fresh signup, while the record, its
// bookings, wallet and withdrawal history all stay.
//
// It used to be a hard delete that also dropped the wallet (money that may
// still be owed), with a `cascade=true` mode that wiped every booking, refund
// and wallet row the partner ever touched — the records the GST report and
// payouts are built on. That mode also told each customer their booking was
// cancelled and then crashed before deleting anything.
router.delete("/:id", audit("admin.partners.delete"), async (req, res) => {
  try {
    const partnerId = asSingleString(req.params.id);
    const force = req.query.force === "true";

    if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid partner id", null, { requestId: req.requestId });
    }
    // An admin panel build from before this change can still send it.
    if (req.query.cascade === "true") {
      return fail(
        res,
        400,
        "CASCADE_NOT_SUPPORTED",
        "Booking history can no longer be wiped. Delete the partner on its own — their bookings, refunds and wallet records are kept.",
        null,
        { requestId: req.requestId }
      );
    }

    const pid = new mongoose.Types.ObjectId(partnerId);
    const [partner, activeBookingDocs, wallet, pendingWithdrawals] = await Promise.all([
      Partner.findById(partnerId).lean(),
      Booking.find({
        $or: [{ partner: pid }, { additionalPartners: pid }],
        status: { $in: ACTIVE_STATUSES },
      }).select("_id user status").lean(),
      PartnerWallet.findOne({ partnerId: pid }).lean(),
      Withdrawal.countDocuments({ partnerId: pid, status: "PENDING" }),
    ]);

    if (!partner || partner.isDeleted) {
      return fail(res, 404, "NOT_FOUND", "Partner not found", null, { requestId: req.requestId });
    }

    // Money first. A deleted partner can't sign in to withdraw, so anything
    // still in the wallet — or a withdrawal waiting on us — would be stranded.
    // (`balance` mirrors withdrawableBalance; a legacy wallet may only have it.)
    const walletOwed =
      Math.round(
        (Math.max(Number(wallet?.withdrawableBalance || 0), Number(wallet?.balance || 0)) +
          Number(wallet?.pendingBalance || 0)) *
          100
      ) / 100;
    if (walletOwed > 0 || pendingWithdrawals > 0) {
      const owed = [];
      if (walletOwed > 0) owed.push(`₹${walletOwed} in their wallet`);
      if (pendingWithdrawals > 0) owed.push(`${pendingWithdrawals} pending withdrawal request(s)`);
      return fail(
        res,
        409,
        "PARTNER_HAS_BALANCE",
        `Cannot delete: this partner still has ${owed.join(" and ")}. Settle it first, or block the partner instead.`,
        null,
        { requestId: req.requestId, walletOwed, pendingWithdrawals }
      );
    }

    if (activeBookingDocs.length > 0 && !force) {
      return fail(
        res,
        409,
        "PARTNER_HAS_ACTIVE_BOOKINGS",
        `Cannot delete: partner has ${activeBookingDocs.length} active booking(s). Use force=true to unassign them and delete.`,
        null,
        { requestId: req.requestId, activeBookings: activeBookingDocs.length }
      );
    }

    if (activeBookingDocs.length > 0) {
      // force: unassign active bookings back to SEARCHING
      const bookingIds = activeBookingDocs.map((b) => b._id);
      await Booking.updateMany(
        { _id: { $in: bookingIds } },
        { $set: { status: "SEARCHING", partner: null }, $push: { rejectedPartners: pid } }
      );
      try {
        const { cancelAckTimeout } = require("../../../services/ackTimeout.service");
        for (const b of activeBookingDocs) await cancelAckTimeout(b._id).catch(() => {});
      } catch (_) { /* non-fatal */ }
      if (global.io) {
        for (const b of activeBookingDocs) {
          global.io.to(`user_${b.user}`).emit("booking_update", {
            bookingId: b._id.toString(),
            status: "SEARCHING",
          });
        }
      }
    }

    // Payout details go with the account; the wallet and its history stay.
    // updateOne, not save(): no re-validation of an old record, and no
    // post-save hook re-creating a wallet.
    await PartnerPayoutAccount.deleteOne({ partnerId: pid });
    await Partner.updateOne(
      { _id: pid },
      {
        $set: {
          name: "Deleted Partner",
          phone: `deleted_${partnerId}`,
          email: "",
          fcmToken: "",
          isBlocked: true,
          isOnline: false,
          isDeleted: true,
          deletedAt: new Date(),
          deleteReason: "Removed by admin",
        },
      }
    );

    if (global.io) {
      global.io.to(`partner_${partnerId}`).emit("partner_account_deleted", {
        message: "Your partner account was deleted by admin. Please sign up again.",
      });
    }

    return success(res, {
      deleted: true,
      partnerId,
      phone: partner.phone,
      unassignedBookings: activeBookingDocs.length,
    }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "PARTNER_DELETE_FAILED", "Unable to delete partner", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
