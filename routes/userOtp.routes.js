const express = require("express");
const router = express.Router();
const {
  sendOtp,
  verifyOtp,
  exchangeMsg91AccessToken,
} = require("../controllers/userOtp.controller");

router.post("/send-otp", sendOtp);
router.post("/verify-otp", verifyOtp);
router.post("/msg91/exchange", exchangeMsg91AccessToken);

module.exports = router;
