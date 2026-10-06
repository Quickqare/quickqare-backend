const express = require("express");
const mongoose = require("mongoose");
const Coupon = require("../../../models/coupon");
const CouponRedemption = require("../../models/CouponRedemption");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { asSingleString, getPagination } = require("../../utils/common");
const { success, fail } = require("../../utils/response");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.COUPONS_MANAGE));

// From the admin form a blank field, null and 0 all mean "not set".
const optionalNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return number === 0 ? null : number;
};

// One set of rules for create and edit; returns the problem, or null.
// Checkout caps any discount at the order value, so a bad coupon can't push a
// total below zero — but 150% off, a negative discount, or a usage limit of 0
// (which passes validation and then fails at redemption) is never intended.
function couponProblem({ discountType, discountValue, minAmount, maxDiscount, usageLimit, perUserLimit, expiresAt }) {
  if (!["flat", "percent"].includes(discountType)) return "Discount type must be flat or percent";
  if (!Number.isFinite(discountValue) || discountValue <= 0) return "Discount must be more than 0";
  if (discountType === "percent" && discountValue > 100) return "A percent discount can't be more than 100";
  if (!Number.isFinite(minAmount) || minAmount < 0) return "Minimum order can't be negative";
  if (maxDiscount !== null && !(maxDiscount > 0)) return "Max discount must be more than 0, or left empty";
  if (usageLimit !== null && !(Number.isInteger(usageLimit) && usageLimit >= 1)) {
    return "Usage limit must be a whole number of 1 or more";
  }
  if (!(Number.isInteger(perUserLimit) && perUserLimit >= 1)) {
    return "Per-user limit must be a whole number of 1 or more";
  }
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) return "Expiry date is not valid";
  return null;
}

router.get("/", async (req, res) => {
  try {
    const { page, pageSize, skip, limit } = getPagination(req);
    const [rows, total] = await Promise.all([
      Coupon.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Coupon.countDocuments(),
    ]);
    return success(res, rows, { requestId: req.requestId, pagination: { page, pageSize, total } });
  } catch (error) {
    return fail(res, 500, "COUPONS_LIST_FAILED", "Unable to fetch coupons", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post("/", audit("admin.coupons.create"), async (req, res) => {
  try {
    const code = String(req.body.code || "").trim().toUpperCase();
    if (!code) {
      return fail(res, 400, "VALIDATION_ERROR", "Coupon code is required", null, { requestId: req.requestId });
    }

    // A new coupon must state its usage limit — Number(undefined) is NaN and
    // fails the rule; only an edit may leave an existing "no limit" as it is.
    const rules = {
      discountType: String(req.body.discountType || req.body.type || "percent").toLowerCase(),
      discountValue: Number(req.body.discountValue ?? req.body.value ?? req.body.discountPercent),
      minAmount: Number(req.body.minAmount ?? req.body.minOrder ?? 0),
      maxDiscount: optionalNumber(req.body.maxDiscount),
      usageLimit: Number(req.body.usageLimit),
      perUserLimit: Number(req.body.perUserLimit || 1),
      expiresAt: new Date(String(req.body.expiresAt || req.body.expiry || "")),
    };
    const problem = couponProblem(rules);
    if (problem) {
      return fail(res, 400, "VALIDATION_ERROR", problem, null, { requestId: req.requestId });
    }

    const applicableServices = Array.isArray(req.body.applicableServices)
      ? req.body.applicableServices.filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
      : [];

    const row = await Coupon.create({ code, ...rules, isActive: true, applicableServices });

    return success(res, row, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "COUPON_CREATE_FAILED", "Unable to create coupon", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/:id", audit("admin.coupons.update"), async (req, res) => {
  try {
    const couponId = asSingleString(req.params.id);
    if (!couponId || !mongoose.Types.ObjectId.isValid(couponId)) {
      return fail(res, 400, "INVALID_ID", "Invalid coupon id", null, { requestId: req.requestId });
    }

    const patch = {};
    if (req.body.discountType !== undefined || req.body.type !== undefined) {
      patch.discountType = String(req.body.discountType || req.body.type || "percent").toLowerCase();
    }
    if (req.body.discountPercent !== undefined || req.body.discountValue !== undefined || req.body.value !== undefined) {
      patch.discountValue = Number(req.body.discountValue ?? req.body.value ?? req.body.discountPercent);
    }
    if (req.body.expiresAt !== undefined) patch.expiresAt = new Date(req.body.expiresAt);
    if (req.body.expiry !== undefined) patch.expiresAt = new Date(req.body.expiry);
    if (req.body.usageLimit !== undefined) patch.usageLimit = optionalNumber(req.body.usageLimit);
    if (req.body.minAmount !== undefined) patch.minAmount = Number(req.body.minAmount);
    if (req.body.minOrder !== undefined) patch.minAmount = Number(req.body.minOrder);
    if (req.body.maxDiscount !== undefined) patch.maxDiscount = optionalNumber(req.body.maxDiscount);
    if (req.body.perUserLimit !== undefined) patch.perUserLimit = Number(req.body.perUserLimit);

    const existing = await Coupon.findById(couponId).lean();
    if (!existing) {
      return fail(res, 404, "NOT_FOUND", "Coupon not found", null, { requestId: req.requestId });
    }

    // Check the coupon as it would be after this edit — only when a rule is
    // being changed, so a coupon saved before these rules can still be
    // switched off (isActive) without first being "fixed".
    if (Object.keys(patch).length > 0) {
      const problem = couponProblem({
        discountType: patch.discountType ?? existing.discountType,
        discountValue: patch.discountValue ?? existing.discountValue,
        minAmount: patch.minAmount ?? existing.minAmount ?? 0,
        maxDiscount: "maxDiscount" in patch ? patch.maxDiscount : existing.maxDiscount || null,
        usageLimit: "usageLimit" in patch ? patch.usageLimit : existing.usageLimit || null,
        perUserLimit: patch.perUserLimit ?? existing.perUserLimit ?? 1,
        expiresAt: patch.expiresAt ?? existing.expiresAt,
      });
      if (problem) {
        return fail(res, 400, "VALIDATION_ERROR", problem, null, { requestId: req.requestId });
      }
    }

    if (req.body.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);
    if (req.body.applicableServices !== undefined) {
      patch.applicableServices = Array.isArray(req.body.applicableServices)
        ? req.body.applicableServices.filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
        : [];
    }

    const row = await Coupon.findByIdAndUpdate(couponId, { $set: patch }, { new: true }).lean();
    if (!row) {
      return fail(res, 404, "NOT_FOUND", "Coupon not found", null, { requestId: req.requestId });
    }

    return success(res, row, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "COUPON_UPDATE_FAILED", "Unable to update coupon", error.message, {
      requestId: req.requestId,
    });
  }
});

router.delete("/:id", audit("admin.coupons.delete"), async (req, res) => {
  try {
    const couponId = asSingleString(req.params.id);
    if (!couponId || !mongoose.Types.ObjectId.isValid(couponId)) {
      return fail(res, 400, "INVALID_ID", "Invalid coupon id", null, { requestId: req.requestId });
    }

    const usageCount = await CouponRedemption.countDocuments({ couponId });
    if (usageCount > 0) {
      return fail(res, 409, "COUPON_HAS_REDEMPTIONS",
        `Cannot delete — this coupon has been redeemed ${usageCount} time(s). Disable it instead.`,
        null, { requestId: req.requestId }
      );
    }

    const deleted = await Coupon.findByIdAndDelete(couponId);
    if (!deleted) {
      return fail(res, 404, "NOT_FOUND", "Coupon not found", null, { requestId: req.requestId });
    }

    return success(res, { deleted: true }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "COUPON_DELETE_FAILED", "Unable to delete coupon", error.message, {
      requestId: req.requestId,
    });
  }
});

router.get("/:id/usage", async (req, res) => {
  try {
    const couponId = asSingleString(req.params.id);
    if (!couponId || !mongoose.Types.ObjectId.isValid(couponId)) {
      return fail(res, 400, "INVALID_ID", "Invalid coupon id", null, { requestId: req.requestId });
    }

    const rows = await CouponRedemption.find({ couponId })
      .populate("customerId", "name phone email")
      .populate("bookingId")
      .sort({ createdAt: -1 })
      .lean();

    return success(res, rows, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "COUPON_USAGE_FAILED", "Unable to fetch coupon usage", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
