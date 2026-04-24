const express = require("express");
const router = express.Router();
const userAuth = require("../middlewares/userAuth");
const {
  getReferralCode,
  getReferralStats,
  getReferralHistory,
} = require("../controllers/referral.controller");

// Get user's referral code
router.get("/code", userAuth, getReferralCode);

// Get referral stats
router.get("/stats", userAuth, getReferralStats);

// Get referral history
router.get("/history", userAuth, getReferralHistory);

module.exports = router;