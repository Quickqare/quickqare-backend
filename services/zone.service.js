const Zone = require("../models/zone.model");

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

module.exports = {
  filterServicesByZone,
  getZoneCoveragePincodes,
  getZoneServiceKey,
  getZoneServiceKeysFromValues,
  isZoneServiceEnabled,
  resolveZoneForPincode,
};
