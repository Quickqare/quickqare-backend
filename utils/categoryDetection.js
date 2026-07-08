function normalizeCategoryText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Cake/Celebration category detection — shared by assignment matching
// (scheduling_service.js) and the customer-facing catalog availability
// annotation (cakeAvailability.service.js / service.controller.js) so both
// agree on what counts as a "cake" category.
function isCakeCategoryText(value = "") {
  const normalized = normalizeCategoryText(value);
  return (
    normalized.includes("celebration") ||
    normalized.includes("cake") ||
    normalized.includes("baker")
  );
}

module.exports = { normalizeCategoryText, isCakeCategoryText };
