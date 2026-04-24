const express = require("express");
const { getPublicBanners } = require("../controllers/banner.controller");

const router = express.Router();

router.get("/", getPublicBanners);

module.exports = router;
