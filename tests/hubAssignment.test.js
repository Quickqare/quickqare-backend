/**
 * HUB PATH × ASSIGNMENT ENGINE: hubs are per-service-category and may overlap
 * the same H3 cells. These tests pin the category-scoped behaviour of the hub
 * resolvers, the eligibility engine's hub path, and the capacity scope — the
 * exact seams where an overlapping hub of a DIFFERENT category used to block
 * or pollute a booking's partner pool.
 */
const mongoose = require("mongoose");
const Hub = require("../models/Hub");
const Partner = require("../models/Partner");
const Category = require("../models/Category");
const Service = require("../models/service.model");
const {
  resolveHubForH3Cell,
  resolveHubsForCells,
  filterServicesByHubs,
} = require("../services/zone.service");
const { resolveCapacityScope } = require("../services/slotCapacity.service");
const { findEligiblePartnersForBooking } = require("../services/scheduling_service");
const { deriveH3Cell, getH3Ring } = require("../utils/h3");

// Two real points in Kolkata ~2km apart — distinct res-7 cells.
const SPOT_A = { lat: 22.5726, lng: 88.3639 };

const CELL = deriveH3Cell(SPOT_A.lat, SPOT_A.lng);
const RING1 = getH3Ring(CELL, 1);
const NEIGHBOUR_CELL = RING1.find((c) => c !== CELL);

let cleaningCategory;
let gardeningCategory;

beforeEach(async () => {
  cleaningCategory = await Category.create({ name: "Cleaning" });
  gardeningCategory = await Category.create({ name: "Gardening" });
});

async function makeHub(overrides = {}) {
  return Hub.create({
    name: "Hub",
    h3Cells: [CELL],
    resolution: 7,
    category: cleaningCategory._id,
    categoryName: "Cleaning",
    ...overrides,
  });
}

async function makePartner(hub, overrides = {}) {
  return Partner.create({
    name: "Test Partner",
    phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    password: "hashed-irrelevant",
    approvalStatus: "APPROVED",
    assignedHubId: hub ? hub._id : null,
    ...overrides,
  });
}

/* A booking-shaped object for the eligibility engine, pointing at a real
   Service doc so the booking's category resolves from the DB. */
async function makeBookingFor(category) {
  const service = await Service.create({
    name: `${category.name} basic`,
    price: 499,
    category: category._id,
    duration: 60,
  });
  return {
    services: [{ serviceId: service._id }],
    serviceCategory: category.name,
    scheduledDate: "2026-08-01",
    scheduledTime: "10:00",
    pincode: "700001",
    location: { type: "Point", coordinates: [SPOT_A.lng, SPOT_A.lat] },
    h3Cell: CELL,
    rejectedPartners: [],
  };
}

/* ── Resolvers (F1/F2 foundations) ────────────────────────────────────────── */
describe("category-scoped hub resolvers", () => {
  test("resolveHubForH3Cell with categoryId only matches that category's hub", async () => {
    await makeHub({ name: "Gardening Hub", category: gardeningCategory._id, categoryName: "Gardening" });
    const cleaningHub = await makeHub({ name: "Cleaning Hub" });

    const found = await resolveHubForH3Cell(CELL, { categoryId: cleaningCategory._id });
    expect(String(found._id)).toBe(String(cleaningHub._id));

    const none = await resolveHubForH3Cell(CELL, { categoryId: new mongoose.Types.ObjectId() });
    expect(none).toBeNull();
  });

  test("resolveHubsForCells filters by categoryIds and requirePartnerApp", async () => {
    const cleaningHub = await makeHub({ name: "Cleaning Hub" });
    await makeHub({ name: "Gardening Hub", category: gardeningCategory._id, categoryName: "Gardening" });
    await makeHub({ name: "Paused Cleaning Hub", h3Cells: [NEIGHBOUR_CELL], partnerAppEnabled: false });
    await makeHub({ name: "Inactive Cleaning Hub", h3Cells: [NEIGHBOUR_CELL], isActive: false });

    const ids = await resolveHubsForCells(RING1, {
      categoryIds: [String(cleaningCategory._id)],
      requirePartnerApp: true,
    });

    // Only the live, partner-enabled Cleaning hub — not the other category,
    // not the paused one, not the inactive one.
    expect(ids.map(String)).toEqual([String(cleaningHub._id)]);
  });
});

/* ── Eligibility engine hub path (F1/F2) ──────────────────────────────────── */
describe("findEligiblePartnersForBooking (hub mode)", () => {
  test("F1: a paused hub of ANOTHER category on the same cell must not block the booking", async () => {
    // Created first so a category-blind findOne would grab it (natural order).
    await makeHub({
      name: "Paused Gardening Hub",
      category: gardeningCategory._id,
      categoryName: "Gardening",
      partnerAppEnabled: false,
    });
    const cleaningHub = await makeHub({ name: "Cleaning Hub" });
    const partnerA = await makePartner(cleaningHub);

    const booking = await makeBookingFor(cleaningCategory);
    const ranked = await findEligiblePartnersForBooking(booking, [CELL], {
      requireOnline: false,
      useH3: true,
    });

    expect(ranked).toHaveLength(1);
    expect(String(ranked[0].partner._id)).toBe(String(partnerA._id));
  });

  test("F1: partners of an overlapping other-category hub are not in the pool", async () => {
    const cleaningHub = await makeHub({ name: "Cleaning Hub" });
    const gardeningHub = await makeHub({
      name: "Gardening Hub",
      category: gardeningCategory._id,
      categoryName: "Gardening",
    });
    const partnerA = await makePartner(cleaningHub);
    await makePartner(gardeningHub); // must NOT be matched for a cleaning job

    const booking = await makeBookingFor(cleaningCategory);
    const ranked = await findEligiblePartnersForBooking(booking, [CELL], {
      requireOnline: false,
      useH3: true,
    });

    expect(ranked).toHaveLength(1);
    expect(String(ranked[0].partner._id)).toBe(String(partnerA._id));
  });

  test("F2: a paused same-category hub reached via ring expansion lends no partners", async () => {
    const homeHub = await makeHub({ name: "Home Hub" });
    const pausedNeighbour = await makeHub({
      name: "Paused Neighbour Hub",
      h3Cells: [NEIGHBOUR_CELL],
      partnerAppEnabled: false,
    });
    const partnerA = await makePartner(homeHub);
    await makePartner(pausedNeighbour); // must NOT be matched via the ring

    const booking = await makeBookingFor(cleaningCategory);
    const ranked = await findEligiblePartnersForBooking(booking, RING1, {
      requireOnline: false,
      useH3: true,
    });

    expect(ranked).toHaveLength(1);
    expect(String(ranked[0].partner._id)).toBe(String(partnerA._id));
  });

  test("home-hub pause gate: a paused hub on the booking's own cell blocks all stages", async () => {
    await makeHub({ name: "Paused Home Hub", partnerAppEnabled: false });
    const enabledNeighbour = await makeHub({
      name: "Enabled Neighbour Hub",
      h3Cells: [NEIGHBOUR_CELL],
    });
    await makePartner(enabledNeighbour);

    const booking = await makeBookingFor(cleaningCategory);
    // Even with the full ring supplied (stage 2 reach), the pause must hold.
    const ranked = await findEligiblePartnersForBooking(booking, RING1, {
      requireOnline: false,
      useH3: true,
    });

    expect(ranked).toHaveLength(0);
  });

  test("precomputedHubIds: caller-resolved pool is used verbatim", async () => {
    const cleaningHub = await makeHub({ name: "Cleaning Hub" });
    const partnerA = await makePartner(cleaningHub);

    const booking = await makeBookingFor(cleaningCategory);

    const withPool = await findEligiblePartnersForBooking(booking, [CELL], {
      requireOnline: false,
      useH3: true,
      precomputedHubIds: [cleaningHub._id],
    });
    expect(withPool).toHaveLength(1);
    expect(String(withPool[0].partner._id)).toBe(String(partnerA._id));

    const emptyPool = await findEligiblePartnersForBooking(booking, [CELL], {
      requireOnline: false,
      useH3: true,
      precomputedHubIds: [],
    });
    expect(emptyPool).toHaveLength(0);
  });
});

/* ── Capacity scope (F4) ──────────────────────────────────────────────────── */
describe("resolveCapacityScope (hub mode)", () => {
  test("F4: bookings in different cells of one hub share ONE scope key despite an overlapping other-category hub", async () => {
    // Gardening hub overlaps the neighbour cell and is created first, so a
    // category-blind findOne on that cell would key capacity to the wrong hub.
    await makeHub({
      name: "Gardening Hub",
      category: gardeningCategory._id,
      categoryName: "Gardening",
      h3Cells: [NEIGHBOUR_CELL],
    });
    const cleaningHub = await makeHub({
      name: "Cleaning Hub",
      h3Cells: [CELL, NEIGHBOUR_CELL],
    });

    const categoryIds = [String(cleaningCategory._id)];
    const scopeHome = await resolveCapacityScope("700001", {
      hubMode: true,
      h3Cell: CELL,
      categoryIds,
    });
    const scopeNeighbour = await resolveCapacityScope("700001", {
      hubMode: true,
      h3Cell: NEIGHBOUR_CELL,
      categoryIds,
    });

    expect(scopeHome.scopeKey).toBe(`hub:${cleaningHub._id}`);
    expect(scopeNeighbour.scopeKey).toBe(`hub:${cleaningHub._id}`);
  });

  test("hub scope carries the category-scoped, partner-enabled pool (hubIds)", async () => {
    const cleaningHub = await makeHub({ name: "Cleaning Hub" });
    await makeHub({
      name: "Paused Neighbour Hub",
      h3Cells: [NEIGHBOUR_CELL],
      partnerAppEnabled: false,
    });

    const scope = await resolveCapacityScope("700001", {
      hubMode: true,
      h3Cell: CELL,
      categoryIds: [String(cleaningCategory._id)],
    });

    expect(scope.hubIds.map(String)).toEqual([String(cleaningHub._id)]);
  });

  test("falls back to pincode scope when no hub covers the cell", async () => {
    const scope = await resolveCapacityScope("700001", {
      hubMode: true,
      h3Cell: CELL,
      categoryIds: [String(cleaningCategory._id)],
    });
    expect(scope.scopeKey).toBe("700001");
  });
});

/* ── Partner services filter (F3) ─────────────────────────────────────────── */
describe("filterServicesByHubs", () => {
  test("keeps only services whose category has a hub here; category-less services stay", () => {
    const hubs = [{ category: cleaningCategory._id }];
    const services = [
      { name: "Sofa cleaning", category: { _id: cleaningCategory._id } },
      { name: "Lawn mowing", category: { _id: gardeningCategory._id } },
      { name: "Legacy no-category service" },
    ];

    const filtered = filterServicesByHubs(services, hubs);

    expect(filtered.map((s) => s.name)).toEqual([
      "Sofa cleaning",
      "Legacy no-category service",
    ]);
  });

  test("no hubs → only category-less services survive", () => {
    const services = [
      { name: "Sofa cleaning", category: { _id: cleaningCategory._id } },
      { name: "Legacy no-category service" },
    ];
    expect(filterServicesByHubs(services, []).map((s) => s.name)).toEqual([
      "Legacy no-category service",
    ]);
  });
});
