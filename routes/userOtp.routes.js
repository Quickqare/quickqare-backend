const express = require("express");
const router = express.Router();
const {
  sendOtp,
  verifyOtp,
  exchangeMsg91AccessToken,
  getMe,
  logout,
} = require("../controllers/userOtp.controller");
const {
  authLimiter,
  phoneOtpLimiter,
  phoneOtpHourlyLimiter,
  phoneOtpVerifyLimiter,
} = require("../middlewares/rateLimiter");
const userAuth = require("../middlewares/userAuth");

router.post("/send-otp", authLimiter, phoneOtpLimiter, phoneOtpHourlyLimiter, sendOtp);
// phoneOtpVerifyLimiter keys on the target phone, so an attacker rotating IPs
// can't grind a 4-digit OTP for one number — mirrors the partner verify route.
router.post("/verify-otp", authLimiter, phoneOtpVerifyLimiter, verifyOtp);
router.post("/msg91/exchange", authLimiter, phoneOtpVerifyLimiter, exchangeMsg91AccessToken);
router.get("/me", userAuth, getMe);
router.post("/logout", logout);

module.exports = router;
