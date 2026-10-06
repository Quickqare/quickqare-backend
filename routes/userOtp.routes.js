const express = require("express");
const router = express.Router();
const {
  sendOtp,
  verifyOtp,
  verifyPhone,
  exchangeMsg91AccessToken,
  getMe,
  logout,
} = require("../controllers/userOtp.controller");
const {
  authLimiter,
  phoneOtpLimiter,
  phoneOtpHourlyLimiter,
  phoneOtpVerifyLimiter,
  otpSendIpHourlyLimiter,
  otpSendIpDailyLimiter,
} = require("../middlewares/rateLimiter");
const userAuth = require("../middlewares/userAuth");

// Per-phone limiters stop one number being flooded; the per-IP ones cap how
// many SMS one client can send to DIFFERENT numbers (SMS bill abuse).
router.post(
  "/send-otp",
  authLimiter,
  otpSendIpHourlyLimiter,
  otpSendIpDailyLimiter,
  phoneOtpLimiter,
  phoneOtpHourlyLimiter,
  sendOtp
);
// phoneOtpVerifyLimiter keys on the target phone, so an attacker rotating IPs
// can't grind a 4-digit OTP for one number — mirrors the partner verify route.
router.post("/verify-otp", authLimiter, phoneOtpVerifyLimiter, verifyOtp);
router.post("/verify-phone", authLimiter, phoneOtpVerifyLimiter, verifyPhone);
router.post("/msg91/exchange", authLimiter, phoneOtpVerifyLimiter, exchangeMsg91AccessToken);
router.get("/me", userAuth, getMe);
router.post("/logout", logout);

module.exports = router;
