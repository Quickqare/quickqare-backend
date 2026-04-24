const { reverseGeocode } = require("../services/geocode.service");
const GOOGLE_MAPS_SERVER_API_KEY =
  process.env.GOOGLE_MAPS_SERVER_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

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

    const resolved = await reverseGeocode(latitude, longitude);
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

    return res.json({
      success: true,
      location: {
        latitude,
        longitude,
        pincode: resolved.pincode || "",
        address: resolved.address || "",
      },
      google: resolved.google || null,
    });
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

    return res.json({
      success: true,
      count: locations.length,
      locations,
      google: {
        status: googleStatus || "OK",
        errorMessage: googleErrorMessage || "",
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Address search failed",
      error: error.message,
    });
  }
};
