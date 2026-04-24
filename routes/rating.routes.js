const express = require("express");
const router = express.Router();
const { submitRating, getPendingRating } = require("../controllers/rating.controller");
const userAuth = require("../middlewares/userAuth");

router.get("/pending", userAuth, getPendingRating);
router.post("/", userAuth, submitRating);

module.exports = router;
