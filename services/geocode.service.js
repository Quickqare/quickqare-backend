/*
=====================================================
GEOCODE SERVICE
Reverse-geocodes lat/lng to a pincode + address
using Google Maps Geocoding API (India).

COST CONTROLS:
  1. In-memory cache keyed by coords rounded to 3 decimal
     places (~100m grid). TTL = 24 hours. Multiple partners
     or users in the same area share one cached result.
  2. Cache is cleared of expired entries every 6 hours to
     prevent unbounded memory growth.
=====================================================
*/

const GOOGLE_MAPS_SERVER_API_KEY =
  process.env.GOOGLE_MAPS_SERVER_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

const { trackApiCall } = require("./apiCallTracker.service");

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — pincodes rarely change
const GEOCODE_REQUEST_TIMEOUT_MS = 5000; // give up on a slow/hung Google call after 5s
const geocodeCache = new Map();

// Round to 4 decimal places ≈ 11m grid precision
function coordCacheKey(lat, lng) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

// Evict expired entries every 6 hours so the Map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of geocodeCache) {
    if (now - entry.ts > CACHE_TTL_MS) geocodeCache.delete(key);
  }
}, 6 * 60 * 60 * 1000);

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

function extractCity(components = []) {
  const order = ["administrative_area_level_2", "locality", "administrative_area_level_1"];
  for (const type of order) {
    const c = components.find((x) => Array.isArray(x?.types) && x.types.includes(type));
    if (c) return String(c.long_name || c.short_name || "").trim();
  }
  return "";
}

function extractArea(components = []) {
  const types = ["sublocality_level_1", "sublocality", "neighborhood", "route"];
  const parts = [];
  for (const type of types) {
    const c = components.find((x) => Array.isArray(x?.types) && x.types.includes(type));
    if (c) {
      const name = String(c.long_name || c.short_name || "").trim();
      if (name && !parts.includes(name)) parts.push(name);
    }
  }
  return parts.join(", ");
}

async function reverseGeocode(latitude, longitude, source = "unknown") {
  if (!GOOGLE_MAPS_SERVER_API_KEY) {
    return {
      ok: false,
      error: "GOOGLE_MAPS_KEY_MISSING",
      message: "Google Maps API key not configured",
    };
  }

  const cacheKey = coordCacheKey(latitude, longitude);
  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    trackApiCall(source, { cacheHit: true });
    return cached.result;
  }

  // Network call is wrapped so a Google outage / DNS failure / timeout returns
  // a graceful ok:false instead of throwing. Callers (e.g. the partner location
  // heartbeat) must still be able to save GPS coordinates when Google is down.
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEOCODE_REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${GOOGLE_MAPS_SERVER_API_KEY}&language=en&region=IN&result_type=street_address|premise|subpremise|route|sublocality`,
      { signal: controller.signal }
    );
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return {
      ok: false,
      error: timedOut ? "GOOGLE_REQUEST_TIMEOUT" : "GOOGLE_REQUEST_ERROR",
      message: timedOut
        ? "Google Maps geocode request timed out"
        : "Google Maps geocode request failed to reach the server",
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return {
      ok: false,
      error: "GOOGLE_REQUEST_FAILED",
      message: "Google Maps geocode request failed",
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return {
      ok: false,
      error: "GOOGLE_BAD_RESPONSE",
      message: "Google Maps returned an unreadable response",
    };
  }
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

  const components = first?.address_components || [];
  const result = {
    ok: true,
    pincode: extractPincodeFromResult(first),
    address: String(first?.formatted_address || "").trim(),
    city: extractCity(components),
    area: extractArea(components),
    google: { status: googleStatus || "OK", errorMessage: googleErrorMessage || "" },
  };
  geocodeCache.set(cacheKey, { result, ts: Date.now() });
  trackApiCall(source, { cacheHit: false });
  return result;
}

/*
=====================================================
FORWARD GEOCODE
Turns a free-text query (e.g. a 6-digit pincode) into
lat/lng coordinates. Used as a fallback when a client
(e.g. the web app on desktop) submits a booking with a
pincode but no GPS. Same cost controls + graceful
failure handling as reverseGeocode.
=====================================================
*/
async function forwardGeocode(query, source = "forward_geocode") {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "EMPTY_QUERY" };
  if (!GOOGLE_MAPS_SERVER_API_KEY) {
    return { ok: false, error: "GOOGLE_MAPS_KEY_MISSING" };
  }

  const cacheKey = `fwd:${q.toLowerCase()}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    trackApiCall(source, { cacheHit: true });
    return cached.result;
  }

  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEOCODE_REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        q
      )}&key=${GOOGLE_MAPS_SERVER_API_KEY}&language=en&region=IN&components=country:IN`,
      { signal: controller.signal }
    );
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return {
      ok: false,
      error: timedOut ? "GOOGLE_REQUEST_TIMEOUT" : "GOOGLE_REQUEST_ERROR",
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) return { ok: false, error: "GOOGLE_REQUEST_FAILED" };

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return { ok: false, error: "GOOGLE_BAD_RESPONSE" };
  }

  const googleStatus = String(data?.status || "");
  if (googleStatus && googleStatus !== "OK") {
    return { ok: false, error: "GOOGLE_STATUS_NOT_OK", google: { status: googleStatus } };
  }

  const first = Array.isArray(data?.results) ? data.results[0] : null;
  const lat = Number(first?.geometry?.location?.lat);
  const lng = Number(first?.geometry?.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: "NO_COORDS" };
  }

  const result = {
    ok: true,
    lat,
    lng,
    pincode: extractPincodeFromResult(first),
    address: String(first?.formatted_address || "").trim(),
  };
  geocodeCache.set(cacheKey, { result, ts: Date.now() });
  trackApiCall(source, { cacheHit: false });
  return result;
}

module.exports = { reverseGeocode, forwardGeocode };
