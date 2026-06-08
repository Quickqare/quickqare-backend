/**
 * NEW H3 PATH: when useH3Zones is on, a booking is allowed only if the
 * customer's GPS falls inside an active Hub. This tests the exact gate the
 * booking + available-services controllers use — resolveHubForLocation — with
 * the real Hub model, real h3-js, and a real (in-memory) database.
 */
const Hub = require("../models/Hub");
const { deriveH3Cell, getH3Ring } = require("../utils/h3");
const { resolveHubForLocation } = require("../services/zone.service");

// A real point in Kolkata and a far-away point in Mumbai.
const KOLKATA = { lat: 22.5726, lng: 88.3639 };
const MUMBAI = { lat: 19.076, lng: 72.8777 };

async function makeHubCovering(point, overrides = {}) {
  const cell = deriveH3Cell(point.lat, point.lng);
  return Hub.create({
    name: "Test Hub",
    h3Cells: [cell],
    resolution: 7,
    ...overrides,
  });
}

describe("Hub-based booking gate (resolveHubForLocation)", () => {
  test("ALLOWS: a customer inside an active hub resolves to that hub", async () => {
    const hub = await makeHubCovering(KOLKATA);

    const found = await resolveHubForLocation(KOLKATA.lat, KOLKATA.lng);

    expect(found).not.toBeNull();
    expect(String(found._id)).toBe(String(hub._id));
  });

  test("BLOCKS: a customer outside every hub resolves to null", async () => {
    await makeHubCovering(KOLKATA);

    // Mumbai is nowhere near the Kolkata hub's cell.
    const found = await resolveHubForLocation(MUMBAI.lat, MUMBAI.lng);

    expect(found).toBeNull();
  });

  test("BLOCKS: an inactive hub is not returned even if it covers the point", async () => {
    await makeHubCovering(KOLKATA, { isActive: false });

    const found = await resolveHubForLocation(KOLKATA.lat, KOLKATA.lng);

    expect(found).toBeNull();
  });

  test("BLOCKS: invalid coordinates resolve to null (never throws)", async () => {
    await makeHubCovering(KOLKATA);

    const found = await resolveHubForLocation(NaN, NaN);

    expect(found).toBeNull();
  });

  test("ring fallback: a point whose exact cell is just outside the hub is allowed leniently but blocked strictly", async () => {
    // Build a hub from the 6 neighbours of the Kolkata centre cell, but NOT the
    // centre cell itself — simulating a pincode centroid landing just outside.
    const centreCell = deriveH3Cell(KOLKATA.lat, KOLKATA.lng);
    const neighbours = getH3Ring(centreCell, 1).filter((c) => c !== centreCell);
    await Hub.create({ name: "Ring Hub", h3Cells: neighbours, resolution: 7 });

    // Strict (precise GPS): exact cell not in hub → blocked.
    const strict = await resolveHubForLocation(KOLKATA.lat, KOLKATA.lng);
    expect(strict).toBeNull();

    // Lenient (pincode fallback): a neighbour cell belongs to the hub → allowed.
    const lenient = await resolveHubForLocation(KOLKATA.lat, KOLKATA.lng, { ringFallback: true });
    expect(lenient).not.toBeNull();
    expect(lenient.name).toBe("Ring Hub");
  });

  test("carries the service flags so the controller can gate per-service", async () => {
    await makeHubCovering(KOLKATA, {
      services: { acRepair: true, plumbing: false, mehendi: true, electrician: true },
    });

    const found = await resolveHubForLocation(KOLKATA.lat, KOLKATA.lng);

    expect(found.services.acRepair).toBe(true);
    expect(found.services.plumbing).toBe(false);
  });
});
