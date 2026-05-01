const { getAvailableSlotsForRequest } = require("./scheduling_service");

/*
=====================================================
SLOT AVAILABILITY SERVICE
Thin wrapper around the scheduling engine.
Passes all cart context (including AC category)
so the slot engine can apply the correct capacity
buffer, duration cap, and skill-tier filter.
=====================================================
*/
async function getAvailableSlots(
  date,
  serviceId,
  serviceCategory,
  options = {}
) {
  return getAvailableSlotsForRequest({
    date,
    serviceId,
    serviceCategory,
    services: Array.isArray(options.services) ? options.services : [],
    pincode: options.pincode || "",
    location: options.location || null,
  });
}

module.exports = {
  getAvailableSlots,
};
