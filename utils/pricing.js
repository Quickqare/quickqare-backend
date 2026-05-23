/**
 * =====================================================
 * PRODUCTION PRICING ENGINE
 * Backend is the source of truth for money
 *
 * Supports:
 * - single service booking
 * - multi-service cart
 * - quantity per service
 * - GST calculation
 * - coupon discounts
 * - invoice breakdown
 * =====================================================
 */

const DEFAULT_TAX_PERCENT = 18;

/*
=====================================================
LOAD PRICING SETTINGS FROM ADMIN
Returns sane defaults (0 platform fee, 18% tax)
when no settings document exists.
=====================================================
*/
async function getPricingSettings() {
  const AdminSetting = require("../admin/models/AdminSetting");
  const settings = await AdminSetting.findOne().lean();
  return {
    platformFeePercent: Number(settings?.pricing?.platformFeePercent) || 0,
    platformFeeFlatInr: Number(settings?.pricing?.platformFeeFlatInr) || 0,
    taxPercent:         Number(settings?.pricing?.taxPercent ?? DEFAULT_TAX_PERCENT),
  };
}
exports.getPricingSettings = getPricingSettings;

function normalizeText(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function getMinimalMehendiHandsPrice(hands = 1) {
  const quantity = Math.max(Number(hands) || 1, 1);

  if (quantity === 1) return 399;
  if (quantity === 2) return 699;
  if (quantity === 3) return 999;
  if (quantity === 4) return 1199;
  return quantity * 299;
}

function getPalmLengthMehendiHandsPrice(hands = 1) {
  const quantity = Math.max(Number(hands) || 1, 1);

  if (quantity === 1) return 499;
  if (quantity === 2) return 798;
  if (quantity === 3) return 1149;
  if (quantity === 4) return 1499;
  return quantity * 399;
}

function getBangleLengthMehendiHandsPrice(hands = 1) {
  const quantity = Math.max(Number(hands) || 1, 1);

  if (quantity === 1) return 799;
  if (quantity === 2) return 1199;
  if (quantity === 3) return 1699;
  if (quantity === 4) return 2199;
  return Math.round(quantity * 599 * 0.95);
}

function getMidLengthMehendiHandsPrice(hands = 1) {
  const quantity = Math.max(Number(hands) || 1, 1);

  if (quantity === 1) return 999;
  if (quantity === 2) return 1499;
  if (quantity === 3) return 2099;
  if (quantity === 4) return 2599;
  return quantity * 629;
}

function getElbowLengthBridalMehendiHandsPrice(hands = 1) {
  const quantity = Math.max(Number(hands) || 1, 1);

  if (quantity === 1) return 1799;
  if (quantity === 2) return 3000;
  return round(quantity * 1799 * 0.75);
}

function getAboveElbowBridalMehendiHandsPrice(hands = 1) {
  const quantity = Math.max(Number(hands) || 1, 1);

  if (quantity === 1) return 2000;
  if (quantity === 2) return 3500;
  // 3+ hands: fall back to a 25% bulk discount on the per-hand rate, mirroring
  // the elbow-length curve. Previously returned null → callers hit
  // `price <= 0` and the booking was rejected with no useful explanation.
  return Math.round(quantity * 2000 * 0.75);
}

function getMehendiPricingRuleKey(serviceName = "") {
  const normalized = normalizeText(serviceName);

  if (normalized.includes("minimal mehendi")) {
    return "mehendi_minimal_hands";
  }

  if (normalized.includes("palm length mehendi")) {
    return "mehendi_palm_length_hands";
  }

  if (normalized.includes("bangle length mehendi")) {
    return "mehendi_bangle_length_hands";
  }

  if (normalized.includes("mid length mehendi")) {
    return "mehendi_mid_length_hands";
  }

  if (normalized.includes("elbow length bridal mehendi")) {
    return "mehendi_elbow_bridal_hands";
  }

  if (normalized.includes("above elbow bridal mehendi")) {
    return "mehendi_above_elbow_bridal_hands";
  }

  return null;
}

function getMehendiHandsPrice(pricingRuleKey, hands = 1) {
  if (pricingRuleKey === "mehendi_minimal_hands") {
    return getMinimalMehendiHandsPrice(hands);
  }

  if (pricingRuleKey === "mehendi_palm_length_hands") {
    return getPalmLengthMehendiHandsPrice(hands);
  }

  if (pricingRuleKey === "mehendi_bangle_length_hands") {
    return getBangleLengthMehendiHandsPrice(hands);
  }

  if (pricingRuleKey === "mehendi_mid_length_hands") {
    return getMidLengthMehendiHandsPrice(hands);
  }

  if (pricingRuleKey === "mehendi_elbow_bridal_hands") {
    return getElbowLengthBridalMehendiHandsPrice(hands);
  }

  if (pricingRuleKey === "mehendi_above_elbow_bridal_hands") {
    return getAboveElbowBridalMehendiHandsPrice(hands);
  }

  return null;
}

/*
=====================================================
SAFE ROUND (avoid floating errors)
=====================================================
*/
function round(amount) {
  return Math.round(amount);
}

/*
=====================================================
CALCULATE CART BASE AMOUNT
services = [
  { price: 500, quantity: 2 }
]
=====================================================
*/
function calculateBaseAmount(services = []) {
  if (!services.length) return 0;

  return services.reduce((total, item) => {
    const price = Number(item.price || 0);
    const quantity = Number(item.quantity || 1);
    return total + price * quantity;
  }, 0);
}

/*
=====================================================
MAIN PRICING FUNCTION
Supports:
- old → baseAmount
- new → services[]
=====================================================
*/
exports.calculatePricing = ({
  baseAmount = 0,
  services = [],
  discount = 0,
  pricing = {},
}) => {
  /*
  =====================================
  DETERMINE BASE AMOUNT
  =====================================
  */
  let calculatedBase = baseAmount;

  if (services?.length) {
    calculatedBase = calculateBaseAmount(services);
  }

  calculatedBase = round(calculatedBase);

  /*
  =====================================
  APPLY DISCOUNT
  =====================================
  */
  const discountAmount = Math.min(
    round(discount),
    calculatedBase
  );

  const taxableAmount = Math.max(
    calculatedBase - discountAmount,
    0
  );

  /*
  =====================================
  PLATFORM FEE  (flat ₹ + % of taxable)
  =====================================
  */
  const platformFeePercent = Number(pricing?.platformFeePercent) || 0;
  const platformFeeFlatInr = Number(pricing?.platformFeeFlatInr) || 0;
  const platformFeeAmount = round(
    (taxableAmount * platformFeePercent) / 100 + platformFeeFlatInr
  );

  /*
  =====================================
  TAX  (% of taxable + platform fee)
  Stored as `gstAmount` for backwards
  compatibility — customer-facing
  label is "Fees and Taxes".
  =====================================
  */
  const taxPercent = Number(pricing?.taxPercent ?? DEFAULT_TAX_PERCENT);
  const gstAmount = round(
    ((taxableAmount + platformFeeAmount) * taxPercent) / 100
  );

  /*
  =====================================
  FINAL TOTAL
  =====================================
  */
  const totalAmount = round(taxableAmount + platformFeeAmount + gstAmount);

  return {
    baseAmount: calculatedBase,
    discountAmount,
    platformFeeAmount,
    gstAmount,
    totalAmount,

    breakdown: {
      taxableAmount,
      platformFeePercent,
      platformFeeFlatInr,
      taxPercent,
      itemCount: services?.length || 1,
    },
  };
};

exports.getMinimalMehendiHandsPrice = getMinimalMehendiHandsPrice;
exports.getPalmLengthMehendiHandsPrice = getPalmLengthMehendiHandsPrice;
exports.getBangleLengthMehendiHandsPrice = getBangleLengthMehendiHandsPrice;
exports.getMidLengthMehendiHandsPrice = getMidLengthMehendiHandsPrice;
exports.getElbowLengthBridalMehendiHandsPrice =
  getElbowLengthBridalMehendiHandsPrice;
exports.getAboveElbowBridalMehendiHandsPrice =
  getAboveElbowBridalMehendiHandsPrice;
exports.getMehendiPricingRuleKey = getMehendiPricingRuleKey;
exports.getMehendiHandsPrice = getMehendiHandsPrice;
