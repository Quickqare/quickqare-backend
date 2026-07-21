function normalizeCategoryText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Cake/Celebration category detection — shared by assignment matching
// (scheduling_service.js), the baker daily-cap aggregate, and the
// customer-facing catalog availability annotation
// (cakeAvailability.service.js / service.controller.js) so ALL of them agree
// on what counts as a "cake" category. The regex form exists so Mongo $match
// stages can use the exact same terms as the in-process text check — keep the
// two in lockstep by only ever editing the regex.
const CAKE_CATEGORY_REGEX = /celebration|cake|baker/i;

function isCakeCategoryText(value = "") {
  return CAKE_CATEGORY_REGEX.test(normalizeCategoryText(value));
}

module.exports = { normalizeCategoryText, isCakeCategoryText, CAKE_CATEGORY_REGEX };
