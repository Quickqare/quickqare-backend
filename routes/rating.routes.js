const express = require("express");
const router = express.Router();
const { submitRating, getPendingRating } = require("../controllers/rating.controller");
const auth = require("../middlewares/auth"); // Assuming standard auth middleware

router.get("/pending", auth, getPendingRating);
router.post("/", auth, submitRating);

module.exports = router;