const express = require("express");
const router = express.Router();
const {
  sendOtp,
  verifyOtp,
  exchangeMsg91AccessToken,
} = require("../controllers/userOtp.controller");
const { authLimiter } = require("../middlewares/rateLimiter");

router.post("/send-otp", authLimiter, sendOtp);
router.post("/verify-otp", authLimiter, verifyOtp);
router.post("/msg91/exchange", authLimiter, exchangeMsg91AccessToken);

module.exports = router;
