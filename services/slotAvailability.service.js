const { getAvailableSlotsForRequest } = require("./scheduling.service");

async function getAvailableSlots(date, serviceId, serviceCategory, options = {}) {
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
