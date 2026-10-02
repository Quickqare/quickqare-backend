/**
 * Matching rules surfaced by women's beauty bookings:
 *  - a single-partner job needs a partner who lists EVERY service in the
 *    cart (partial matches only make sense on AC / mehendi team jobs);
 *  - Category.partnerGender limits who may deliver a category;
 *  - the zone service gate no longer files "face" / "facial" / "bleach"
 *    under AC, while real AC values (and the zone keys themselves) still
 *    resolve to acRepair.
 */
const Partner = require("../models/Partner");
const Category = require("../models/Category");
const Service = require("../models/service.model");
const {
  findEligiblePartnersForBooking,
  getPartnerGenderRule,
  computeTeamPackForBooking,
  planTeamAssignment,
} = require("../services/scheduling_service");
const {
  getZoneServiceKey,
  getZoneServiceKeysFromValues,
  isZoneServiceEnabled,
} = require("../services/zone.service");

const PINCODE = "700001";

async function makePartner(overrides = {}) {
  return Partner.create({
    name: "Test Partner",
    phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    password: "hashed-irrelevant",
    approvalStatus: "APPROVED",
    serviceAreas: [PINCODE],
    ...overrides,
  });
}

// The capability snapshot partner signup stores (Partner.services).
function offers(...services) {
  return services.map((s) => ({ serviceId: s._id, name: s.name, isActive: true }));
}

function bookingFor(...services) {
  return {
    services: services.map((s) => ({ serviceId: s._id, quantity: 1 })),
    scheduledDate: "2026-08-01",
    scheduledTime: "10:00",
    pincode: PINCODE,
    rejectedPartners: [],
  };
}

async function eligibleIds(booking) {
  const ranked = await findEligiblePartnersForBooking(booking, [PINCODE], {
    requireOnline: false,
  });
  return ranked.map((e) => String(e.partner._id)).sort();
}

describe("single-partner jobs need a full skill match", () => {
  test("a partner who lists only some of the cart's services is not eligible", async () => {
    const salon = await Category.create({ name: "Salon for Women", slug: "salon-for-women" });
    const waxing = await Service.create({ name: "Full arms waxing", price: 299, category: salon._id, duration: 45 });
    const facial = await Service.create({ name: "Instant glow facial", price: 770, category: salon._id, duration: 60 });
    const waxOnly = await makePartner({ services: offers(waxing) });
    const both = await makePartner({ services: offers(waxing, facial) });

    // Waxing + facial goes to one beautician, so only the one who does both.
    expect(await eligibleIds(bookingFor(waxing, facial))).toEqual([String(both._id)]);
    // Waxing alone: both qualify.
    expect(await eligibleIds(bookingFor(waxing))).toEqual(
      [String(waxOnly._id), String(both._id)].sort()
    );
  });

  test("AC team jobs still accept a partial match — the partner takes some bins", async () => {
    const ac = await Category.create({ name: "AC", slug: "ac", categoryType: "AC" });
    const cleaning = await Service.create({ name: "Split AC cleaning", price: 499, category: ac._id, duration: 60 });
    const gas = await Service.create({ name: "AC gas refill", price: 2499, category: ac._id, duration: 90 });
    const cleaner = await makePartner({ services: offers(cleaning) });

    const ranked = await findEligiblePartnersForBooking(bookingFor(cleaning, gas), [PINCODE], {
      requireOnline: false,
    });
    expect(ranked.map((e) => String(e.partner._id))).toEqual([String(cleaner._id)]);
    expect(ranked[0].skillMatchLevel).toBe(2.5);
  });
});

describe("Category.partnerGender", () => {
  test("a women-only category matches only partners registered as FEMALE", async () => {
    const salon = await Category.create({
      name: "Salon for Women",
      slug: "salon-for-women",
      partnerGender: "FEMALE",
    });
    const waxing = await Service.create({ name: "Bikini waxing", price: 949, category: salon._id, duration: 45 });
    const woman = await makePartner({ gender: "FEMALE", services: offers(waxing) });
    await makePartner({ gender: "MALE", services: offers(waxing) });
    await makePartner({ gender: "OTHER", services: offers(waxing) });
    await makePartner({ gender: "", services: offers(waxing) }); // legacy: never set

    expect(await eligibleIds(bookingFor(waxing))).toEqual([String(woman._id)]);
    expect(await getPartnerGenderRule(bookingFor(waxing))).toEqual({
      required: "FEMALE",
      conflict: false,
    });
  });

  test("ANY (the default) adds no restriction", async () => {
    const plumbing = await Category.create({ name: "Plumbing", slug: "plumbing" });
    const tap = await Service.create({ name: "Tap repair", price: 199, category: plumbing._id, duration: 30 });
    await makePartner({ gender: "FEMALE", services: offers(tap) });
    await makePartner({ gender: "MALE", services: offers(tap) });
    await makePartner({ gender: "", services: offers(tap) });

    expect(await eligibleIds(bookingFor(tap))).toHaveLength(3);
    expect(await getPartnerGenderRule(bookingFor(tap))).toEqual({
      required: null,
      conflict: false,
    });
  });

  test("a cart mixing women-only and men-only categories has no valid partner", async () => {
    const women = await Category.create({ name: "Salon for Women", slug: "salon-for-women", partnerGender: "FEMALE" });
    const men = await Category.create({ name: "Salon for Men", slug: "salon-for-men", partnerGender: "MALE" });
    const facial = await Service.create({ name: "Hydration facial", price: 449, category: women._id, duration: 45 });
    const haircut = await Service.create({ name: "Men's haircut", price: 199, category: men._id, duration: 30 });
    await makePartner({ gender: "FEMALE", services: offers(facial, haircut) });
    await makePartner({ gender: "MALE", services: offers(facial, haircut) });

    const booking = bookingFor(facial, haircut);
    expect(await eligibleIds(booking)).toEqual([]);
    expect(await getPartnerGenderRule(booking)).toEqual({ required: null, conflict: true });
  });
});

describe("salon / self-care skill tiers and team split", () => {
  test("a tier-2 salon service goes only to senior (tier-2) beauticians", async () => {
    const salon = await Category.create({ name: "Salon for Women", slug: "salon-for-women" });
    const korean = await Service.create({
      name: "Korean glass-skin facial", price: 1599, category: salon._id, duration: 90, skillTier: 2,
    });
    await makePartner({ skillTier: 1, services: offers(korean) });
    const senior = await makePartner({ skillTier: 2, services: offers(korean) });

    expect(await eligibleIds(bookingFor(korean))).toEqual([String(senior._id)]);
  });

  test("tier-1 salon services still go to any beautician", async () => {
    const salon = await Category.create({ name: "Salon for Women", slug: "salon-for-women" });
    const threading = await Service.create({ name: "Eyebrow threading", price: 49, category: salon._id, duration: 15 });
    await makePartner({ skillTier: 1, services: offers(threading) });
    await makePartner({ skillTier: 2, services: offers(threading) });

    expect(await eligibleIds(bookingFor(threading))).toHaveLength(2);
  });

  test("categoryType SALON gates tiers under any category name", async () => {
    const cat = await Category.create({ name: "Glow Studio", slug: "glow-studio", categoryType: "SALON" });
    const peel = await Service.create({ name: "Chemical peel", price: 1999, category: cat._id, duration: 60, skillTier: 2 });
    await makePartner({ skillTier: 1, services: offers(peel) });
    const senior = await makePartner({ skillTier: 2, services: offers(peel) });

    expect(await eligibleIds(bookingFor(peel))).toEqual([String(senior._id)]);
  });

  test("a long salon cart needs a 2-beautician team", async () => {
    const salon = await Category.create({ name: "Salon for Women", slug: "salon-for-women" });
    const cart = [];
    for (const [name, duration] of [
      ["Full body waxing", 120],
      ["Deluxe pedicure", 60],
      ["Instant glow facial", 60],
      ["Hair spa", 60],
      ["Deluxe manicure", 35],
    ]) {
      cart.push(await Service.create({ name, price: 499, category: salon._id, duration }));
    }
    const booking = bookingFor(...cart);
    const pack = await computeTeamPackForBooking(booking);
    expect(pack.requiredCount).toBe(2);

    await makePartner({ services: offers(...cart) });
    const one = await findEligiblePartnersForBooking(booking, [PINCODE], { requireOnline: false });
    expect(planTeamAssignment(one, pack)).toBeNull(); // one beautician can't staff both shares

    await makePartner({ services: offers(...cart) });
    const two = await findEligiblePartnersForBooking(booking, [PINCODE], { requireOnline: false });
    expect(planTeamAssignment(two, pack)).toHaveLength(2);
  });
});

describe("salon ranking — weights and repeat-partner affinity", () => {
  const mongoose = require("mongoose");
  const Rating = require("../models/Rating");
  const {
    AC_SCORE_WEIGHTS,
    GENERAL_SCORE_WEIGHTS,
    SALON_SCORE_WEIGHTS,
    REPEAT_PARTNER_BONUS,
    REPEAT_PARTNER_PENALTY,
    REPEAT_PARTNER_LOOKBACK_DAYS,
    calculatePartnerScore,
    repeatPartnerAdjustment,
  } = require("../services/scheduling_service");

  const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);

  test("every weight set sums to 1", () => {
    for (const w of [AC_SCORE_WEIGHTS, GENERAL_SCORE_WEIGHTS, SALON_SCORE_WEIGHTS]) {
      expect(sum(w)).toBeCloseTo(1, 10);
    }
  });

  test("salon weights reward a full service match more than general weights", () => {
    const partner = { rating: 4.5, lastAssignedAt: null };
    const base = { distanceMeters: 2000, partner, earningsToday: 500 };
    const gap = (isSalon) =>
      calculatePartnerScore({ ...base, skillMatchLevel: 3, isSalon }).score -
      calculatePartnerScore({ ...base, skillMatchLevel: 1, isSalon }).score;
    // Level 3 (100) vs level 1 (50): 50 × 0.25 = 12.5 salon vs 50 × 0.10 = 5 general.
    expect(gap(true)).toBeCloseTo(12.5, 1);
    expect(gap(false)).toBeCloseTo(5, 1);
  });

  test("repeatPartnerAdjustment: good → bonus, poor → penalty, middling → 0", () => {
    expect(repeatPartnerAdjustment(5)).toBe(REPEAT_PARTNER_BONUS);
    expect(repeatPartnerAdjustment(4)).toBe(REPEAT_PARTNER_BONUS);
    expect(repeatPartnerAdjustment(3)).toBe(0);
    expect(repeatPartnerAdjustment(2)).toBe(-REPEAT_PARTNER_PENALTY);
    expect(repeatPartnerAdjustment(undefined)).toBe(0);
  });

  async function rate(customerId, partnerId, rating, daysAgo = 10) {
    const doc = await Rating.create({
      bookingId: new mongoose.Types.ObjectId(),
      customerId,
      partnerId,
      rating,
    });
    const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    await Rating.collection.updateOne({ _id: doc._id }, { $set: { createdAt: at } });
  }

  async function salonSetup() {
    const salon = await Category.create({ name: "Salon for Women", slug: "salon-for-women" });
    const facial = await Service.create({ name: "Hydration facial", price: 449, category: salon._id, duration: 45 });
    const a = await makePartner({ services: offers(facial) });
    const b = await makePartner({ services: offers(facial) });
    const customer = new mongoose.Types.ObjectId();
    return { facial, a, b, customer };
  }

  async function rankFor(booking) {
    return findEligiblePartnersForBooking(booking, [PINCODE], { requireOnline: false });
  }

  test("a beautician the customer rated well ranks first", async () => {
    const { facial, a, b, customer } = await salonSetup();
    // Without history, identical partners tie and sort by id → a first.
    const [firstPlain] = await rankFor({ ...bookingFor(facial), user: customer });
    expect(String(firstPlain.partner._id)).toBe(String(a._id));

    await rate(customer, b._id, 5);
    const ranked = await rankFor({ ...bookingFor(facial), user: customer });
    expect(String(ranked[0].partner._id)).toBe(String(b._id));
    expect(ranked[0].repeatBonus).toBe(REPEAT_PARTNER_BONUS);
    expect(ranked[0].score - ranked[1].score).toBeCloseTo(REPEAT_PARTNER_BONUS, 2);
    expect(ranked[0].weightProfile).toBe("SALON");
  });

  test("the latest rating wins, and a poor one pushes the partner down", async () => {
    const { facial, a, customer } = await salonSetup();
    await rate(customer, a._id, 5, 60);
    await rate(customer, a._id, 1, 5); // newer visit went badly
    const ranked = await rankFor({ ...bookingFor(facial), user: customer });
    const entryA = ranked.find((e) => String(e.partner._id) === String(a._id));
    expect(entryA.repeatBonus).toBe(-REPEAT_PARTNER_PENALTY);
    expect(String(ranked[ranked.length - 1].partner._id)).toBe(String(a._id));
  });

  test("ratings older than the lookback, or by other customers, are ignored", async () => {
    const { facial, b, customer } = await salonSetup();
    await rate(customer, b._id, 5, REPEAT_PARTNER_LOOKBACK_DAYS + 5);
    await rate(new mongoose.Types.ObjectId(), b._id, 5);
    const ranked = await rankFor({ ...bookingFor(facial), user: customer });
    expect(ranked.every((e) => e.repeatBonus === 0)).toBe(true);
  });

  test("non-salon categories get no repeat affinity", async () => {
    const plumbing = await Category.create({ name: "Plumbing", slug: "plumbing" });
    const tap = await Service.create({ name: "Tap repair", price: 199, category: plumbing._id, duration: 30 });
    const p = await makePartner({ services: offers(tap) });
    const customer = new mongoose.Types.ObjectId();
    await rate(customer, p._id, 5);
    const [entry] = await rankFor({ ...bookingFor(tap), user: customer });
    expect(entry.repeatBonus).toBe(0);
    expect(entry.weightProfile).toBe("GENERAL");
  });
});

describe("zone service gate", () => {
  test("beauty names that merely contain the letters 'ac' are not AC", () => {
    for (const value of [
      "Facials & cleanups",
      "Face waxing",
      "Face bleach",
      "Bleach & detan",
      "Full-face threading",
      "Korean glass-skin facial",
    ]) {
      expect(getZoneServiceKey(value)).toBeNull();
    }
  });

  test("real AC values still resolve to acRepair", () => {
    for (const value of [
      "AC",
      "ac",
      "ac-repair",
      "AC Repair",
      "Split AC service",
      "Window AC installation",
      "Air Conditioner",
      "airconditioner",
    ]) {
      expect(getZoneServiceKey(value)).toBe("acRepair");
    }
  });

  test("zone keys resolve to themselves (createBooking maps values to keys twice)", () => {
    for (const key of ["acRepair", "plumbing", "mehendi", "electrician", "celebration"]) {
      expect(getZoneServiceKey(key)).toBe(key);
    }
  });

  test("longer aliases keep matching plurals", () => {
    expect(getZoneServiceKey("Plumbers")).toBe("plumbing");
    expect(getZoneServiceKey("Birthday cakes")).toBe("celebration");
    expect(getZoneServiceKey("Electricians")).toBe("electrician");
  });

  test("a zone with AC switched off takes face waxing and facials but still blocks AC", () => {
    const zone = { services: { acRepair: false } };
    // Same two-step shape as createBooking: values → keys, then the gate.
    const beautyKeys = getZoneServiceKeysFromValues([
      "salon-for-women",
      "Face waxing",
      "Instant glow facial",
      "Face bleach",
    ]);
    const acKeys = getZoneServiceKeysFromValues(["ac", "Split AC service"]);

    expect(isZoneServiceEnabled(zone, beautyKeys)).toBe(true);
    expect(isZoneServiceEnabled(zone, acKeys)).toBe(false);
  });
});
