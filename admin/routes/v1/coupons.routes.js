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
    const discountType = String(req.body.discountType || req.body.type || "percent").toLowerCase();
    const discountValue = Number(
      req.body.discountValue ?? req.body.value ?? req.body.discountPercent
    );
    const expiresAtRaw = String(req.body.expiresAt || req.body.expiry || "");
    const usageLimit = Number(req.body.usageLimit);

    if (
      !code ||
      !["flat", "percent"].includes(discountType) ||
      !Number.isFinite(discountValue) ||
      discountValue <= 0
    ) {
      return fail(res, 400, "VALIDATION_ERROR", "code and valid discountType/value are required", null, {
        requestId: req.requestId,
      });
    }
    if (!expiresAtRaw || !Number.isFinite(usageLimit) || usageLimit < 1) {
      return fail(res, 400, "VALIDATION_ERROR", "expiresAt and usageLimit are required", null, {
        requestId: req.requestId,
      });
    }

    const row = await Coupon.create({
      code,
      discountType,
      discountValue,
      minAmount: Number(req.body.minAmount ?? req.body.minOrder ?? 0),
      maxDiscount: req.body.maxDiscount !== undefined ? Number(req.body.maxDiscount) : null,
      usageLimit,
      perUserLimit: Number(req.body.perUserLimit || 1),
      expiresAt: new Date(expiresAtRaw),
      isActive: true,
    });

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
    if (req.body.usageLimit !== undefined) patch.usageLimit = Number(req.body.usageLimit);
    if (req.body.minAmount !== undefined) patch.minAmount = Number(req.body.minAmount);
    if (req.body.minOrder !== undefined) patch.minAmount = Number(req.body.minOrder);
    if (req.body.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);

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
