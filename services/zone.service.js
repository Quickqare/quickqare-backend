const Zone = require("../models/zone.model");
const Hub = require("../models/Hub");
const Service = require("../models/service.model");
const Category = require("../models/Category");
const mongoose = require("mongoose");
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
//
// categoryId: when supplied, only hubs serving that service category match.
// Hubs are per-service and may overlap, so a booking for AC must land inside an
// *AC* hub — being inside a Mehendi hub covering the same area is not enough.
async function resolveHubForLocation(lat, lng, { ringFallback = false, k = 1, categoryId = null } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const cell = deriveH3Cell(lat, lng);
  if (!cell) return null;

  const catFilter = categoryId ? { category: categoryId } : {};

  const exact = await Hub.findOne({ h3Cells: cell, isActive: true, ...catFilter }).lean();
  if (exact || !ringFallback) return exact;

  // No hub on the exact cell — widen to neighbours to absorb centroid fuzz.
  const ringCells = getH3Ring(cell, k).filter((c) => c !== cell);
  if (!ringCells.length) return null;
  return Hub.findOne({ h3Cells: { $in: ringCells }, isActive: true, ...catFilter }).lean();
}

/**
 * Resolves the distinct service categories a booking/request needs, so hub
 * gates can check coverage *per service*. Accepts the loose shape used across
 * the booking flow ({ services?: [{ serviceId }], serviceId?, serviceCategory? }).
 * `serviceCategory` may be a Category id, slug, or name. Returns [{ id, name }];
 * empty when nothing is resolvable (legacy flow) so callers can fall back to an
 * area-level check.
 */
async function resolveBookingCategories({ services, serviceId, serviceCategory } = {}) {
  const serviceIds = [];
  if (Array.isArray(services)) {
    for (const it of services) if (it?.serviceId) serviceIds.push(String(it.serviceId));
  }
  if (serviceId) serviceIds.push(String(serviceId));

  const validIds = [...new Set(serviceIds)].filter((id) => mongoose.Types.ObjectId.isValid(id));
  const categoryIds = new Set();

  if (validIds.length) {
    const svcs = await Service.find({ _id: { $in: validIds } }).select("category").lean();
    for (const s of svcs) {
      if (s?.category && mongoose.Types.ObjectId.isValid(String(s.category))) {
        categoryIds.add(String(s.category));
      }
    }
  }

  // Legacy single-category flow: only a category id / slug / name was sent.
  if (!categoryIds.size && serviceCategory) {
    const term = String(serviceCategory).trim();
    if (mongoose.Types.ObjectId.isValid(term)) {
      categoryIds.add(term);
    } else if (term) {
      const cat = await Category.findOne({
        $or: [{ slug: term.toLowerCase() }, { name: term }],
      })
        .select("_id")
        .lean();
      if (cat) categoryIds.add(String(cat._id));
    }
  }

  if (!categoryIds.size) return [];
  const cats = await Category.find({ _id: { $in: [...categoryIds] } }).select("name").lean();
  return cats.map((c) => ({ id: String(c._id), name: c.name }));
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
  resolveBookingCategories,
};
