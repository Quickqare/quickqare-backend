/*
=====================================================
GEOCODE SERVICE
Reverse-geocodes lat/lng to a pincode + address
using Google Maps Geocoding API (India).
=====================================================
*/

const GOOGLE_MAPS_SERVER_API_KEY =
  process.env.GOOGLE_MAPS_SERVER_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

const PINCODE_REGEX = /\b\d{6}\b/;

function normalizePincode(value = "") {
  const text = String(value).trim();
  const match = text.match(PINCODE_REGEX);
  return match ? match[0] : "";
}

function extractPincodeFromComponents(components = []) {
  const postal = components.find(
    (item) => Array.isArray(item?.types) && item.types.includes("postal_code")
  );
  return normalizePincode(postal?.long_name || postal?.short_name || "");
}

function extractPincodeFromResult(result) {
  const fromComponents = extractPincodeFromComponents(
    result?.address_components || []
  );
  if (fromComponents) return fromComponents;
  return normalizePincode(String(result?.formatted_address || ""));
}

async function reverseGeocode(latitude, longitude) {
  if (!GOOGLE_MAPS_SERVER_API_KEY) {
    return {
      ok: false,
      error: "GOOGLE_MAPS_KEY_MISSING",
      message: "Google Maps API key not configured",
    };
  }

  const response = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${GOOGLE_MAPS_SERVER_API_KEY}&language=en&region=IN`
  );

  if (!response.ok) {
    return {
      ok: false,
      error: "GOOGLE_REQUEST_FAILED",
      message: "Google Maps geocode request failed",
    };
  }

  const data = await response.json();
  const googleStatus = String(data?.status || "");
  const googleErrorMessage = String(data?.error_message || "");

  if (googleStatus && googleStatus !== "OK") {
    return {
      ok: false,
      error: "GOOGLE_STATUS_NOT_OK",
      message: "Google Maps returned non-OK status",
      google: { status: googleStatus, errorMessage: googleErrorMessage },
    };
  }

  const first = Array.isArray(data?.results) ? data.results[0] : null;
  if (!first) {
    return {
      ok: true,
      pincode: "",
      address: "",
      google: { status: googleStatus || "EMPTY_RESULTS", errorMessage: googleErrorMessage || "" },
    };
  }

  return {
    ok: true,
    pincode: extractPincodeFromResult(first),
    address: String(first?.formatted_address || "").trim(),
    google: { status: googleStatus || "OK", errorMessage: googleErrorMessage || "" },
  };
}

module.exports = { reverseGeocode };
