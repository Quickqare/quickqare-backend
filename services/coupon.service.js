const Coupon = require("../models/coupon");
const CouponRedemption = require("../admin/models/CouponRedemption");

const roundAmount = (value) =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const normalizeCode = (code) => String(code || "").trim().toUpperCase();

const buildCouponDiscount = (coupon, amount) => {
  const baseAmount = Math.max(roundAmount(amount), 0);
  let discount = 0;

  if (coupon.discountType === "flat") {
    discount = Number(coupon.discountValue || 0);
  } else {
    discount = Math.round((baseAmount * Number(coupon.discountValue || 0)) / 100);
  }

  if (coupon.maxDiscount && discount > coupon.maxDiscount) {
    discount = Number(coupon.maxDiscount || 0);
  }

  discount = Math.min(roundAmount(discount), baseAmount);

  return {
    discount,
    finalAmount: roundAmount(baseAmount - discount),
  };
};

const serializeCoupon = (coupon, amount) => {
  const { discount, finalAmount } = buildCouponDiscount(coupon, amount);

  return {
    _id: coupon._id,
    code: coupon.code,
    type: coupon.discountType,
    value: Number(coupon.discountValue || 0),
    minOrder: Number(coupon.minAmount || 0),
    maxDiscount: coupon.maxDiscount ?? null,
    expiry: coupon.expiresAt,
    usageLimit: coupon.usageLimit ?? null,
    usedCount: Number(coupon.usedCount || 0),
    perUserLimit: Number(coupon.perUserLimit || 1),
    estimatedDiscount: discount,
    finalAmount,
    displayText:
      coupon.discountType === "flat"
        ? `Rs ${discount} OFF`
        : `${Number(coupon.discountValue || 0)}% OFF${
            coupon.maxDiscount ? ` up to Rs ${coupon.maxDiscount}` : ""
          }`,
  };
};

const validateCouponForAmount = async ({ code, amount, customerId = null }) => {
  const normalizedCode = normalizeCode(code);
  const baseAmount = Number(amount || 0);

  if (!normalizedCode) {
    const err = new Error("Coupon code is required");
    err.statusCode = 400;
    throw err;
  }

  if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
    const err = new Error("Valid amount is required");
    err.statusCode = 400;
    throw err;
  }

  const coupon = await Coupon.findOne({
    code: normalizedCode,
    isActive: true,
  });

  if (!coupon) {
    const err = new Error("Invalid coupon");
    err.statusCode = 400;
    throw err;
  }

  if (coupon.expiresAt && coupon.expiresAt < new Date()) {
    const err = new Error("Coupon expired");
    err.statusCode = 400;
    throw err;
  }

  if (baseAmount < Number(coupon.minAmount || 0)) {
    const err = new Error(`Minimum order Rs ${Number(coupon.minAmount || 0)} required`);
    err.statusCode = 400;
    throw err;
  }

  if (
    coupon.usageLimit &&
    Number(coupon.usedCount || 0) >= Number(coupon.usageLimit || 0)
  ) {
    const err = new Error("Coupon usage limit reached");
    err.statusCode = 400;
    throw err;
  }

  if (customerId && coupon.perUserLimit) {
    const usedByCustomer = await CouponRedemption.countDocuments({
      couponId: coupon._id,
      customerId,
    });

    if (usedByCustomer >= Number(coupon.perUserLimit || 1)) {
      const err = new Error("Coupon usage limit reached for this user");
      err.statusCode = 400;
      throw err;
    }
  }

  const { discount, finalAmount } = buildCouponDiscount(coupon, baseAmount);

  return {
    coupon,
    discount,
    finalAmount,
    response: serializeCoupon(coupon, baseAmount),
  };
};

const listApplicableCoupons = async ({ amount }) => {
  const baseAmount = Number(amount || 0);

  if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
    return [];
  }

  const coupons = await Coupon.find({ isActive: true })
    .sort({ createdAt: -1 })
    .lean();

  return coupons
    .filter((coupon) => !coupon.expiresAt || new Date(coupon.expiresAt) >= new Date())
    .filter((coupon) => baseAmount >= Number(coupon.minAmount || 0))
    .filter(
      (coupon) =>
        !coupon.usageLimit ||
        Number(coupon.usedCount || 0) < Number(coupon.usageLimit || 0)
    )
    .map((coupon) => serializeCoupon(coupon, baseAmount))
    .sort((a, b) => {
      const discountDiff = Number(b.estimatedDiscount || 0) - Number(a.estimatedDiscount || 0);
      if (discountDiff !== 0) return discountDiff;
      return new Date(a.expiry).getTime() - new Date(b.expiry).getTime();
    });
};

const recordCouponRedemption = async ({
  couponId,
  bookingId,
  customerId,
  discountAmountInr,
}) => {
  if (!couponId || !bookingId || !customerId) return null;

  const existing = await CouponRedemption.findOne({ bookingId }).lean();
  if (existing) return existing;

  const redemption = await CouponRedemption.create({
    couponId,
    bookingId,
    customerId,
    discountAmountInr: Number(discountAmountInr || 0),
  });

  await Coupon.findByIdAndUpdate(couponId, {
    $inc: { usedCount: 1 },
  });

  return redemption;
};

module.exports = {
  normalizeCode,
  buildCouponDiscount,
  serializeCoupon,
  validateCouponForAmount,
  listApplicableCoupons,
  recordCouponRedemption,
};
