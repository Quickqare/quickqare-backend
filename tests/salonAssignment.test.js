/**
 * End-to-end salon / self-care assignment through the real engine:
 *  - the beautician the customer rated well wins a close ranking, and the
 *    audit records the SALON weight profile + per-candidate repeat bonus
 *    (what the weight-shadow report replays);
 *  - a tier-2 service skips a better-ranked junior beautician;
 *  - a cart longer than one beautician's visit is staffed by two, with the
 *    payout split by each one's share of the minutes.
 */
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const Category = require("../models/Category");
const Service = require("../models/service.model");
const Rating = require("../models/Rating");
const { assignBooking } = require("../services/assignmentEngine");
const { REPEAT_PARTNER_BONUS } = require("../services/scheduling_service");

const PINCODE = "700091";

function nextWeekAt10() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(10, 0, 0, 0);
  return d;
}

async function makePartner(overrides = {}) {
  return Partner.create({
    name: "Beautician",
    phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    password: "hashed-irrelevant",
    approvalStatus: "APPROVED",
    gender: "FEMALE",
    serviceAreas: [PINCODE],
    ...overrides,
  });
}

const offers = (...services) =>
  services.map((s) => ({ serviceId: s._id, name: s.name, isActive: true }));

async function makeBooking(user, services) {
  const start = nextWeekAt10();
  return Booking.create({
    user,
    baseAmount: 1000,
    totalAmount: 1000,
    scheduledDate: start,
    scheduledTime: "10:00",
    scheduledStartAt: start,
    pincode: PINCODE,
    location: { type: "Point", coordinates: [88.43, 22.57] },
    status: "PENDING_ASSIGNMENT",
    serviceCategory: "Salon for Women",
    services: services.map((s) => ({
      serviceId: s._id,
      name: s.name,
      price: 499,
      lineTotal: 499,
      quantity: 1,
      category: "Salon for Women",
    })),
  });
}

async function salonCategory() {
  return Category.create({ name: "Salon for Women", slug: "salon-for-women" });
}

test("repeat customer gets the beautician they rated well; audit records why", async () => {
  const salon = await salonCategory();
  const facial = await Service.create({ name: "Hydration facial", price: 449, category: salon._id, duration: 45 });
  const a = await makePartner({ services: offers(facial) });
  const b = await makePartner({ services: offers(facial) });
  const customer = new mongoose.Types.ObjectId();
  await Rating.create({ bookingId: new mongoose.Types.ObjectId(), customerId: customer, partnerId: b._id, rating: 5 });

  const booking = await makeBooking(customer, [facial]);
  const picked = await assignBooking(booking._id);
  expect(String(picked._id)).toBe(String(b._id));

  const fresh = await Booking.findById(booking._id).lean();
  expect(String(fresh.partner)).toBe(String(b._id));
  const entry = fresh.assignmentAudit.find(
    (e) => e.event === "SOFT_ASSIGNED" || e.event === "CONFIRMED_AUTO"
  );
  expect(entry.weightProfile).toBe("SALON");
  expect(entry.notes).toMatch(/rated them well/);
  const byId = new Map(entry.candidates.map((c) => [String(c.partnerId), c]));
  expect(byId.get(String(b._id)).repeatBonus).toBe(REPEAT_PARTNER_BONUS);
  expect(byId.get(String(a._id)).repeatBonus).toBe(0);
});

test("a tier-2 treatment skips the junior even when she ranks higher", async () => {
  const salon = await salonCategory();
  const korean = await Service.create({
    name: "Korean glass-skin facial", price: 1599, category: salon._id, duration: 90, skillTier: 2,
  });
  // Junior has been idle far longer, so she would win on score alone.
  await makePartner({ skillTier: 1, services: offers(korean) });
  const senior = await makePartner({ skillTier: 2, services: offers(korean), lastAssignedAt: new Date() });

  const booking = await makeBooking(new mongoose.Types.ObjectId(), [korean]);
  const picked = await assignBooking(booking._id);
  expect(String(picked._id)).toBe(String(senior._id));
});

test("a long cart is staffed by two beauticians with a minutes-based payout split", async () => {
  const salon = await salonCategory();
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
  await makePartner({ services: offers(...cart) });
  await makePartner({ services: offers(...cart) });

  const booking = await makeBooking(new mongoose.Types.ObjectId(), cart);
  expect(await assignBooking(booking._id)).not.toBeNull();

  const fresh = await Booking.findById(booking._id).lean();
  expect(fresh.additionalPartners).toHaveLength(1);
  expect(fresh.teamAllocations).toHaveLength(2);
  const minutes = fresh.teamAllocations.map((t) => t.assignedMinutes).sort((x, y) => x - y);
  expect(minutes).toEqual([155, 180]);
  const ratioSum = fresh.teamAllocations.reduce((s, t) => s + t.payoutRatio, 0);
  expect(ratioSum).toBeCloseTo(1, 4);
});
