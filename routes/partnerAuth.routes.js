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
} = require("../controllers/partnerAuth.controller");

const partnerAuth = require("../middlewares/partnerAuth");

const validate = require("../middlewares/validate");
const {
  registerPartnerValidator,
} = require("../middlewares/validators");

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
router.post("/login", loginPartner);
router.post("/send-otp", sendPartnerOtp);
router.post("/verify-otp", verifyPartnerOtp);
router.post("/msg91/exchange", exchangePartnerMsg91AccessToken);
router.post("/reset-password-msg91", resetPartnerPasswordWithMsg91);

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
