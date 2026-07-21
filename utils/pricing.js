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

/*
=====================================================
MEHENDI HAND-PACKAGE PRICING
Tiered price by number of hands (index = hands - 1);
beyond the last tier the total falls back to
round(hands × overflowPerHand) — the per-hand bulk
rate. The tables below are the CODE DEFAULTS; admin
can override any of them via
AdminSetting.mehendiHandsPricing without a deploy
(see getMehendiHandsPriceWithSettings).
=====================================================
*/
const DEFAULT_MEHENDI_HANDS_PRICING = {
  mehendi_minimal_hands: {
    tierPrices: [399, 699, 999, 1199],
    overflowPerHand: 299,
  },
  mehendi_palm_length_hands: {
    tierPrices: [499, 798, 1149, 1499],
    overflowPerHand: 399,
  },
  mehendi_bangle_length_hands: {
    tierPrices: [799, 1199, 1699, 2199],
    overflowPerHand: 569.05, // 599 × 0.95 bulk rate
  },
  mehendi_mid_length_hands: {
    tierPrices: [999, 1499, 2099, 2599],
    overflowPerHand: 629,
  },
  mehendi_elbow_bridal_hands: {
    tierPrices: [1799, 3000],
    overflowPerHand: 1349.25, // 1799 × 0.75 bulk rate
  },
  mehendi_above_elbow_bridal_hands: {
    tierPrices: [2000, 3500],
    // 25% bulk discount on the per-hand rate, mirroring the elbow-length
    // curve. Previously returned null → callers hit `price <= 0` and the
    // booking was rejected with no useful explanation.
    overflowPerHand: 1500, // 2000 × 0.75 bulk rate
  },
};

const MEHENDI_PRICING_RULE_KEYS = Object.keys(DEFAULT_MEHENDI_HANDS_PRICING);

function resolveMehendiHandsPriceFromTable(table, hands = 1) {
  const quantity = Math.max(Number(hands) || 1, 1);
  const tierPrice = Array.isArray(table?.tierPrices)
    ? Number(table.tierPrices[quantity - 1])
    : NaN;
  if (Number.isFinite(tierPrice) && tierPrice > 0) return tierPrice;
  const overflowPerHand = Number(table?.overflowPerHand);
  if (!Number.isFinite(overflowPerHand) || overflowPerHand <= 0) return null;
  return Math.round(quantity * overflowPerHand);
}

// Name-based fallback detection. Only used when the Service record has no
// explicit pricingRuleKey (legacy rows) — an admin rename would silently
// break this matching, which is exactly why pricingRuleKey exists.
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

// Sync variant — code defaults only. Kept for tests/back-compat; booking
// pricing should use getMehendiHandsPriceWithSettings so admin overrides apply.
function getMehendiHandsPrice(pricingRuleKey, hands = 1) {
  const table = DEFAULT_MEHENDI_HANDS_PRICING[pricingRuleKey];
  if (!table) return null;
  return resolveMehendiHandsPriceFromTable(table, hands);
}

// Admin-overridable variant. Reads AdminSetting.mehendiHandsPricing with a
// 60s cache (same pattern as the useH3Zones flag); any rule whose override
// has no positive tier prices falls back to the code defaults, so a blank or
// half-filled admin form can never zero out live pricing.
let _mehendiPricingCache = { value: null, expiresAt: 0 };
async function getMehendiHandsPriceWithSettings(pricingRuleKey, hands = 1) {
  if (!DEFAULT_MEHENDI_HANDS_PRICING[pricingRuleKey]) return null;

  if (Date.now() >= _mehendiPricingCache.expiresAt) {
    try {
      const AdminSetting = require("../admin/models/AdminSetting");
      const settings = await AdminSetting.findOne()
        .select("mehendiHandsPricing")
        .lean();
      _mehendiPricingCache = {
        value: settings?.mehendiHandsPricing || null,
        expiresAt: Date.now() + 60_000,
      };
    } catch {
      _mehendiPricingCache.expiresAt = Date.now() + 10_000;
    }
  }

  const override = _mehendiPricingCache.value?.[pricingRuleKey];
  const hasUsableOverride =
    Array.isArray(override?.tierPrices) &&
    override.tierPrices.some((p) => Number(p) > 0);
  const table = hasUsableOverride
    ? override
    : DEFAULT_MEHENDI_HANDS_PRICING[pricingRuleKey];
  return resolveMehendiHandsPriceFromTable(table, hands);
}

/*
=====================================================
CAKE (CELEBRATION) CUSTOMIZATION PRICING
Options are validated by name against the Service's
admin-managed `customization` config — client prices
are never trusted.
=====================================================
*/

const MAX_NAME_ON_CAKE_LENGTH = 40;
const MAX_REFERENCE_PHOTO_URL_LENGTH = 1024;

/**
 * Validates a cake options payload against service.customization.
 * Returns { ok: true, options } with resolved (server-priced) values,
 * or { ok: false, message } when the payload is invalid.
 */
function validateCakeOptions(service, rawOptions = {}) {
  const config = service?.customization;
  if (!config || !Array.isArray(config.flavours) || config.flavours.length === 0) {
    return { ok: false, message: "This service has no customization options" };
  }

  // Flavour — when selection is disabled the first flavour is the fixed
  // default; an explicit different flavour (e.g. an older client) is rejected.
  const flavourName = String(rawOptions.flavour || "").trim();
  let flavour;
  if (config.flavoursEnabled === false) {
    flavour = config.flavours[0];
    if (flavourName && normalizeText(flavourName) !== normalizeText(flavour.name)) {
      return { ok: false, message: "Flavour selection is not available for this service" };
    }
  } else {
    flavour = config.flavours.find(
      (f) => normalizeText(f.name) === normalizeText(flavourName)
    );
    if (!flavour) {
      return { ok: false, message: `Invalid flavour: ${flavourName || "(none)"}` };
    }
  }

  // Weight/size is optional per service — only validated when the service has
  // weight tiers configured and selection is enabled. Falls back to the first
  // (base) weight if omitted. When disabled, only the base weight (or none)
  // is accepted and no weight is recorded.
  let weight = null;
  if (config.weightsEnabled === false) {
    const rawWeight = String(rawOptions.weight || "").trim();
    const baseWeight = Array.isArray(config.weights) ? config.weights[0] : null;
    if (rawWeight && (!baseWeight || normalizeText(rawWeight) !== normalizeText(baseWeight.label))) {
      return { ok: false, message: "Weight selection is not available for this service" };
    }
  } else if (Array.isArray(config.weights) && config.weights.length > 0) {
    const weightLabel = String(rawOptions.weight || "").trim() || config.weights[0].label;
    const matchedWeight = config.weights.find(
      (w) => normalizeText(w.label) === normalizeText(weightLabel)
    );
    if (!matchedWeight) {
      return { ok: false, message: `Invalid weight: ${weightLabel}` };
    }
    weight = matchedWeight.label;
  }

  const tiers = Number(rawOptions.tiers) || 1;
  if (tiers !== 1 && tiers !== 2) {
    return { ok: false, message: "tiers must be 1 or 2" };
  }
  if (tiers === 2 && config.tiersEnabled === false) {
    return { ok: false, message: "Two-tier is not available for this service" };
  }

  const eggless = Boolean(rawOptions.eggless);
  if (eggless && config.egglessOptionEnabled === false) {
    return { ok: false, message: "Eggless option is not available for this service" };
  }

  const addonNames = Array.isArray(rawOptions.addons) ? rawOptions.addons : [];
  if (addonNames.length > 0 && config.addonsEnabled === false) {
    return { ok: false, message: "Add-ons are not available for this service" };
  }
  const addons = [];
  for (const rawName of addonNames) {
    const addon = (config.addons || []).find(
      (a) => normalizeText(a.name) === normalizeText(String(rawName || ""))
    );
    if (!addon) {
      return { ok: false, message: `Invalid addon: ${rawName}` };
    }
    if (addons.some((a) => normalizeText(a.name) === normalizeText(addon.name))) {
      continue; // ignore duplicates
    }
    addons.push({ name: addon.name, price: Number(addon.price) || 0 });
  }

  let nameOnCake = String(rawOptions.nameOnCake || "").trim();
  if (nameOnCake && config.nameOnCakeEnabled === false) {
    return { ok: false, message: "Name on cake is not available for this service" };
  }
  nameOnCake = nameOnCake.slice(0, MAX_NAME_ON_CAKE_LENGTH);

  // Customer's "make it look like this" reference photo — a URL from the
  // upload endpoint, not validated against any admin config (display only).
  const referencePhotoUrl = String(rawOptions.referencePhotoUrl || "")
    .trim()
    .slice(0, MAX_REFERENCE_PHOTO_URL_LENGTH);
  if (referencePhotoUrl && config.referencePhotoEnabled === false) {
    return { ok: false, message: "Reference photos are not available for this service" };
  }

  return {
    ok: true,
    options: {
      flavour: flavour.name,
      ...(weight ? { weight } : {}),
      tiers,
      eggless,
      addons,
      nameOnCake,
      ...(referencePhotoUrl ? { referencePhotoUrl } : {}),
    },
  };
}

/**
 * Line total for one customized cake (already-validated options).
 * lineTotal = (base + flavourDelta + weightDelta + twoTierDelta + Σ addons) × quantity
 */
function computeCakeLineTotal(service, options, quantity = 1) {
  const config = service?.customization || {};
  const qty = Math.max(Number(quantity) || 1, 1);

  const flavour = (config.flavours || []).find(
    (f) => normalizeText(f.name) === normalizeText(options.flavour)
  );
  const flavourDelta = Number(flavour?.priceDelta) || 0;

  const weightEntry = options.weight
    ? (config.weights || []).find((w) => normalizeText(w.label) === normalizeText(options.weight))
    : null;
  const weightDelta = Number(weightEntry?.priceDelta) || 0;

  const tierDelta =
    Number(options.tiers) === 2 && config.tiersEnabled !== false
      ? Number(config.twoTierPriceDelta) || 0
      : 0;
  const egglessDelta =
    options.eggless && config.egglessOptionEnabled !== false
      ? Number(config.egglessPriceDelta) || 0
      : 0;
  const addonsTotal = (options.addons || []).reduce(
    (total, addon) => total + (Number(addon.price) || 0),
    0
  );

  const unitPrice = (Number(service.price) || 0) + flavourDelta + weightDelta + tierDelta + egglessDelta + addonsTotal;
  return { unitPrice: round(unitPrice), lineTotal: round(unitPrice * qty) };
}

/**
 * True when a service is configured for per-order customization
 * (i.e. it's a cake/celebration-style service).
 */
function hasCustomization(service) {
  return Boolean(
    service?.customization &&
    Array.isArray(service.customization.flavours) &&
    service.customization.flavours.length > 0
  );
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

exports.DEFAULT_MEHENDI_HANDS_PRICING = DEFAULT_MEHENDI_HANDS_PRICING;
exports.MEHENDI_PRICING_RULE_KEYS = MEHENDI_PRICING_RULE_KEYS;
exports.getMehendiPricingRuleKey = getMehendiPricingRuleKey;
exports.getMehendiHandsPrice = getMehendiHandsPrice;
exports.getMehendiHandsPriceWithSettings = getMehendiHandsPriceWithSettings;
exports.validateCakeOptions = validateCakeOptions;
exports.computeCakeLineTotal = computeCakeLineTotal;
exports.hasCustomization = hasCustomization;
exports.MAX_NAME_ON_CAKE_LENGTH = MAX_NAME_ON_CAKE_LENGTH;
