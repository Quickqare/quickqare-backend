const express = require("express");
const router = express.Router();
const { getOffers } = require("../controllers/offer.controller");

router.get("/", getOffers);

module.exports = router;
