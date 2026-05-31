const express = require("express");
const router = express.Router();

const {
  registerPartner,
  loginPartner,
  sendPartnerOtp,
  setPartnerStatus,
  verifyPartnerOtp,
  exchangePartnerMsg91AccessToken,
  resetPartnerPasswordWithMsg91,
  resetPartnerPassword,
} = require("../controllers/partnerAuth.controller");

const partnerAuth = require("../middlewares/partnerAuth");

const validate = require("../middlewares/validate");
const {
  registerPartnerValidator,
} = require("../middlewares/validators");
const { authLimiter, phoneOtpLimiter, phoneOtpHourlyLimiter } = require("../middlewares/rateLimiter");

/* =====================================================
   PARTNER AUTH ROUTES (PRODUCTION READY)
   Base: /api/partner/auth
===================================================== */

/**
 * ======================================
 * REGISTER PARTNER
 * POST /api/partner/auth/register
 * ======================================
 */
router.post(
  "/register",
  authLimiter,
  registerPartnerValidator,
  validate,
  registerPartner
);

/**
 * ======================================
 * LOGIN PARTNER
 * POST /api/partner/auth/login
 * ======================================
 */
router.post("/login", authLimiter, loginPartner);
router.post("/send-otp", authLimiter, phoneOtpLimiter, phoneOtpHourlyLimiter, sendPartnerOtp);
router.post("/verify-otp", authLimiter, verifyPartnerOtp);
router.post("/msg91/exchange", authLimiter, exchangePartnerMsg91AccessToken);
router.post("/reset-password-msg91", authLimiter, resetPartnerPasswordWithMsg91);
router.post("/reset-password", authLimiter, partnerAuth, resetPartnerPassword);

/**
 * ======================================
 * SET ONLINE / OFFLINE STATUS
 * PATCH /api/partner/auth/status
 * Body: { isOnline: true/false }
 * ======================================
 */
router.patch(
  "/status",
  partnerAuth,
  setPartnerStatus
);

module.exports = router;
