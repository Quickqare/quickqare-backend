const express = require("express");
const router = express.Router();
const {
  reverseGeocode,
  searchAddress,
} = require("../controllers/maps.controller");

/* ======================
   MAPS ROUTES
   Base: /api/maps
====================== */
router.get("/reverse", reverseGeocode);
router.get("/search", searchAddress);

module.exports = router;

