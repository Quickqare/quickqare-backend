const Partner = require("../models/Partner");
const AdminSetting = require("../admin/models/AdminSetting");
const {
  resolveZoneForPincode,
  resolveHubForLocation,
  isZoneServiceEnabled,
  getZoneCoveragePincodes,
} = require("./zone.service");
const { getUseH3Flag } = require("./useH3Flag.service");

/**
 * Given a customer's location and a set of candidate Celebration cake
 * Service ids, returns the subset that at least one approved, coverage-
 * matching baker has personally declared (via Partner.services[]) they can
 * bake. Mirrors findEligiblePartnersForBooking's base eligibility query
 * (scheduling_service.js) so the "available near you" badge never promises
 * more than a real booking attempt could actually deliver — Stage 1 gates on
 * zone/hub category enablement first (same as getAvailableServicesForLocation
 * in partner.controller.js) before touching the Partner collection at all.
 *
 * Returns an empty array (not an error) whenever location can't be resolved
 * or Celebration isn't enabled there — callers treat that as "nothing available".
 */
async function getAvailableCakeServiceIds({ pincode, lat, lng, cakeServiceIds, categoryId } = {}) {
  const ids = Array.isArray(cakeServiceIds) ? cakeServiceIds.filter(Boolean) : [];
  if (!ids.length) return [];

  const latitude = Number(lat);
  const longitude = Number(lng);
  const hasCoords = Number.isFinite(latitude) && Number.isFinite(longitude);
  const normalizedPincode = String(pincode || "").trim();
  if (!hasCoords && !normalizedPincode) return [];

  const useH3 = await getUseH3Flag();

  const query = {
    isBlocked: false,
    approvalStatus: "APPROVED",
    isDeleted: { $ne: true },
    suspendedUntil: { $not: { $gt: new Date() } },
    isAvailable: { $ne: false },
    "services.serviceId": { $in: ids },
  };

  if (useH3 && hasCoords) {
    const hub = await resolveHubForLocation(latitude, longitude, {
      ringFallback: true,
      categoryId: categoryId || null,
    });
    if (!hub || hub.isActive === false || hub.customerAppEnabled === false) {
      return [];
    }
    query.assignedHubId = hub._id;
  } else {
    if (!normalizedPincode) return [];
    const zone = await resolveZoneForPincode(normalizedPincode);
    if (
      !zone ||
      zone.isActive === false ||
      zone.customerAppEnabled === false ||
      !isZoneServiceEnabled(zone, ["Celebration"])
    ) {
      return [];
    }
    const pincodes = [normalizedPincode, ...getZoneCoveragePincodes(zone)];
    query.$or = [
      { currentPincode: { $in: pincodes } },
      { serviceAreas: { $in: pincodes } },
    ];
  }

  const settings = await AdminSetting.findOne().lean();
  if (settings?.partnerVerificationRequired) {
    query.verificationStatus = "VERIFIED";
  }

  const matchedServiceIds = await Partner.distinct("services.serviceId", query);
  const available = new Set(matchedServiceIds.map(String));
  return ids.filter((id) => available.has(String(id)));
}

module.exports = { getAvailableCakeServiceIds };
