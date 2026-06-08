const Zone = require("../models/zone.model");
const Hub = require("../models/Hub");
const { getH3Ring, deriveH3Cell } = require("../utils/h3");

const SERVICE_KEY_ALIASES = {
  acRepair: ["ac", "air conditioner", "air-conditioner", "airconditioner", "ac repair"],
  plumbing: ["plumbing", "plumber"],
  mehendi: ["mehendi", "mehndi"],
  electrician: ["electrician", "electrical", "electric"],
};

function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizePincode(value) {
  return String(value || "").trim();
}

function getZoneServiceKey(value = "") {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  for (const [key, aliases] of Object.entries(SERVICE_KEY_ALIASES)) {
    if (aliases.some((alias) => normalized.includes(alias))) {
      return key;
    }
  }

  return null;
}

function getZoneServiceKeysFromValues(values = []) {
  return [
    ...new Set(
      values
        .map((value) => getZoneServiceKey(value))
        .filter(Boolean)
    ),
  ];
}

async function resolveZoneForPincode(pincode) {
  const normalized = normalizePincode(pincode);
  if (!normalized) return null;

  const exact = await Zone.findOne({ pincode: normalized }).lean();
  if (exact) return exact;

  const nearby = await Zone.findOne({ nearbyPincodes: normalized }).lean();
  if (nearby) return nearby;

  const extended = await Zone.findOne({ extendedPincodes: normalized }).lean();
  if (extended) return extended;

  return null;
}

function getZoneCoveragePincodes(zone) {
  if (!zone) return [];
  return [
    ...new Set(
      [
        zone.pincode,
        ...(Array.isArray(zone.nearbyPincodes) ? zone.nearbyPincodes : []),
        ...(Array.isArray(zone.extendedPincodes) ? zone.extendedPincodes : []),
      ]
        .map(normalizePincode)
        .filter(Boolean)
    ),
  ];
}

function isZoneServiceEnabled(zone, values = []) {
  if (!zone) return false;

  const serviceKeys = getZoneServiceKeysFromValues(values);
  if (!serviceKeys.length) return true;

  return serviceKeys.every((key) => zone?.services?.[key] !== false);
}

function filterServicesByZone(services = [], zone) {
  if (!zone) return [];

  return services.filter((service) => {
    const key = getZoneServiceKey(
      service?.legacyCategory ||
        service?.category?.slug ||
        service?.category?.name ||
        service?.category?.title ||
        service?.name ||
        ""
    );

    return !key || zone?.services?.[key] !== false;
  });
}

/**
 * Resolves the active Hub that contains a given H3 cell.
 * A hub "contains" a cell when the cell is one of the hub's h3Cells.
 * Returns the hub document, or null.
 */
async function resolveHubForH3Cell(h3Index) {
  if (!h3Index) return null;
  return Hub.findOne({ h3Cells: h3Index, isActive: true }).lean();
}

/**
 * Resolves the set of active Hub _ids whose h3Cells intersect any of
 * the supplied cells. Used by the assignment engine to find which hubs
 * cover a booking's cell (and its ring-expansion cells in later stages).
 */
async function resolveHubsForCells(cells = []) {
  if (!Array.isArray(cells) || !cells.length) return [];
  const hubs = await Hub.find({ h3Cells: { $in: cells }, isActive: true })
    .select("_id")
    .lean();
  return hubs.map((h) => h._id);
}

// Derives the H3 cell for a lat/lng and looks up the active hub containing it.
//
// ringFallback: when the exact cell isn't inside any hub, also check the
// immediate ring of neighbouring cells (~1-2km out) and return the first hub
// found. Used for pincode-geocoded bookings, where the coordinate is a coarse
// pincode centroid that may land just outside a hub boundary. Precise-GPS
// callers should leave it off so a customer genuinely outside all hubs is
// correctly rejected.
async function resolveHubForLocation(lat, lng, { ringFallback = false, k = 1 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const cell = deriveH3Cell(lat, lng);
  if (!cell) return null;

  const exact = await resolveHubForH3Cell(cell);
  if (exact || !ringFallback) return exact;

  // No hub on the exact cell — widen to neighbours to absorb centroid fuzz.
  const ringCells = getH3Ring(cell, k).filter((c) => c !== cell);
  if (!ringCells.length) return null;
  return Hub.findOne({ h3Cells: { $in: ringCells }, isActive: true }).lean();
}

module.exports = {
  filterServicesByZone,
  getZoneCoveragePincodes,
  getZoneServiceKey,
  getZoneServiceKeysFromValues,
  isZoneServiceEnabled,
  resolveZoneForPincode,
  resolveHubForH3Cell,
  resolveHubsForCells,
  resolveHubForLocation,
};
