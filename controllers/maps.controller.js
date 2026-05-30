const { reverseGeocode } = require("../services/geocode.service");
const { trackApiCall } = require("../services/apiCallTracker.service");
const GOOGLE_MAPS_SERVER_API_KEY =
  process.env.GOOGLE_MAPS_SERVER_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

/*
=====================================================
GOOGLE MAPS CACHE
Caches geocode and search responses for 30 days to 
reduce API billing costs drastically.
=====================================================
*/
const mapsCache = new Map();
const REVGEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — reverse geocode should stay fresh
const SEARCH_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — search results rarely change

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of mapsCache.entries()) {
    const ttl = value.ttl || SEARCH_CACHE_TTL_MS;
    if (now - value.timestamp > ttl) {
      mapsCache.delete(key);
    }
  }
}, 12 * 60 * 60 * 1000); // Check every 12 hours

exports.reverseGeocode = async (req, res) => {
  try {
    const latitude = Number(req.query.lat);
    const longitude = Number(req.query.lng);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid lat and lng query params are required",
      });
    }

    // Check Cache (round coordinate precision to ~11m)
    const cacheKey = `revgeo_${latitude.toFixed(4)}_${longitude.toFixed(4)}`;
    const cached = mapsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < REVGEO_CACHE_TTL_MS) {
      trackApiCall("customer_reverse_geocode", { cacheHit: true });
      return res.json(cached.data);
    }

    const resolved = await reverseGeocode(latitude, longitude, "customer_reverse_geocode");
    if (!resolved.ok) {
      const status = resolved.error === "GOOGLE_MAPS_KEY_MISSING" ? 500 : 502;
      return res.status(status).json({
        success: false,
        message:
          resolved.error === "GOOGLE_MAPS_KEY_MISSING"
            ? "Google Maps API key not configured. Set GOOGLE_MAPS_SERVER_API_KEY in backend env."
            : "Google Maps reverse geocode returned non-OK status",
        google: resolved.google || null,
      });
    }

    const responsePayload = {
      success: true,
      location: {
        latitude,
        longitude,
        pincode: resolved.pincode || "",
        address: resolved.address || "",
      },
      google: resolved.google || null,
    };

    mapsCache.set(cacheKey, {
      timestamp: Date.now(),
      ttl: REVGEO_CACHE_TTL_MS,
      data: responsePayload,
    });

    return res.json(responsePayload);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Reverse geocode failed",
      error: error.message,
    });
  }
};

exports.searchAddress = async (req, res) => {
  try {
    if (!GOOGLE_MAPS_SERVER_API_KEY) {
      return res.status(500).json({
        success: false,
        message:
          "Google Maps API key not configured. Set GOOGLE_MAPS_SERVER_API_KEY in backend env.",
      });
    }

    const query = String(req.query.query || "").trim();
    if (!query) {
      return res.status(400).json({
        success: false,
        message: "query is required",
      });
    }

    const cacheKey = `search_${query.toLowerCase()}`;
    const cached = mapsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SEARCH_CACHE_TTL_MS) {
      trackApiCall("customer_address_search", { cacheHit: true });
      return res.json(cached.data);
    }
    trackApiCall("customer_address_search", { cacheHit: false });

    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        query
      )}&key=${GOOGLE_MAPS_SERVER_API_KEY}&language=en&region=IN&components=country:IN`
    );

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        message: "Google Maps search request failed",
      });
    }

    const data = await response.json();
    const googleStatus = String(data?.status || "");
    const googleErrorMessage = String(data?.error_message || "");

    if (googleStatus && googleStatus !== "OK") {
      return res.status(502).json({
        success: false,
        message: "Google Maps address search returned non-OK status",
        google: {
          status: googleStatus,
          errorMessage: googleErrorMessage,
        },
      });
    }

    const results = Array.isArray(data?.results) ? data.results : [];

    const locations = results.slice(0, 6).map((item) => {
      const latitude = Number(item?.geometry?.location?.lat);
      const longitude = Number(item?.geometry?.location?.lng);
        const pincode = String(
          (item?.address_components || [])
            .find(
              (component) =>
                Array.isArray(component?.types) &&
                component.types.includes("postal_code")
            )
            ?.long_name || ""
        ).trim();
      return {
        placeId: String(item?.place_id || ""),
        latitude,
        longitude,
        pincode,
        address: String(item?.formatted_address || "").trim(),
      };
    });

    const responsePayload = {
      success: true,
      count: locations.length,
      locations,
      google: {
        status: googleStatus || "OK",
        errorMessage: googleErrorMessage || "",
      },
    };

    mapsCache.set(cacheKey, {
      timestamp: Date.now(),
      data: responsePayload,
    });

    return res.json(responsePayload);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Address search failed",
      error: error.message,
    });
  }
};
