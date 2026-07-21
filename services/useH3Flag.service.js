const AdminSetting = require("../admin/models/AdminSetting");

/**
 * Cached AdminSetting.useH3Zones flag — refreshed every 60s so hot paths
 * (assignment, slot listing, availability) don't pay a DB read per call.
 *
 * This is the ONE shared copy. It used to be duplicated across
 * assignmentEngine / scheduling_service / cakeAvailability (each module kept
 * its own private cache to avoid circular requires); this module has no
 * dependencies besides the AdminSetting model, so everyone can import it
 * without a cycle and the TTL/fallback behaviour can't drift between copies.
 */
let _cache = { value: false, expiresAt: 0 };

async function getUseH3Flag() {
  if (Date.now() < _cache.expiresAt) return _cache.value;
  try {
    const s = await AdminSetting.findOne().select("useH3Zones").lean();
    _cache = { value: Boolean(s?.useH3Zones), expiresAt: Date.now() + 60_000 };
  } catch {
    _cache.expiresAt = Date.now() + 10_000; // retry sooner on error
  }
  return _cache.value;
}

module.exports = { getUseH3Flag };
