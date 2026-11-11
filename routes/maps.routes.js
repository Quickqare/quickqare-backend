const express = require("express");
const router = express.Router();
const {
  reverseGeocode,
  searchAddress,
} = require("../controllers/maps.controller");
const { mapsLimiter, geoDailyLimiter } = require("../middlewares/rateLimiter");

/* ======================
   MAPS ROUTES
   Base: /api/maps
   Rate-limited per IP — these are unauthenticated proxies to a billed
   Google Maps key, so cap request volume to prevent cost abuse.
====================== */
router.get("/reverse", mapsLimiter, geoDailyLimiter, reverseGeocode);
router.get("/search", mapsLimiter, geoDailyLimiter, searchAddress);

module.exports = router;

