const express = require("express");
const router = express.Router();
const {
  sendOtp,
  verifyOtp,
  exchangeMsg91AccessToken,
  getMe,
  logout,
} = require("../controllers/userOtp.controller");
const { authLimiter, phoneOtpLimiter, phoneOtpHourlyLimiter } = require("../middlewares/rateLimiter");
const userAuth = require("../middlewares/userAuth");

router.post("/send-otp", authLimiter, phoneOtpLimiter, phoneOtpHourlyLimiter, sendOtp);
router.post("/verify-otp", authLimiter, verifyOtp);
router.post("/msg91/exchange", authLimiter, exchangeMsg91AccessToken);
router.get("/me", userAuth, getMe);
router.post("/logout", logout);

module.exports = router;
