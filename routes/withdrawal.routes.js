const express = require("express");
const router = express.Router();

const partnerAuth = require("../middlewares/partnerAuth");

const {
  requestWithdrawal,
  saveBankDetails,
} = require("../controllers/withdrawal.controller");

/* =====================================================
   PARTNER WITHDRAWAL ROUTES (PRODUCTION READY)
   Base: /api/partner/withdrawal
===================================================== */

/**
 * ======================================
 * REQUEST WITHDRAWAL
 * POST /api/partner/withdrawal
 * ======================================
 * Body:
 * { amount }
 */
router.post("/", partnerAuth, requestWithdrawal);

/**
 * ======================================
 * SAVE / UPDATE BANK DETAILS
 * POST /api/partner/withdrawal/bank-details
 * ======================================
 */
router.post("/bank-details", partnerAuth, saveBankDetails);

module.exports = router;