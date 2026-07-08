const express = require("express");
const router = express.Router();
const {
  reverseGeocode,
  searchAddress,
} = require("../controllers/maps.controller");
const { mapsLimiter } = require("../middlewares/rateLimiter");

/* ======================
   MAPS ROUTES
   Base: /api/maps
   Rate-limited per IP — these are unauthenticated proxies to a billed
   Google Maps key, so cap request volume to prevent cost abuse.
====================== */
router.get("/reverse", mapsLimiter, reverseGeocode);
router.get("/search", mapsLimiter, searchAddress);

module.exports = router;

