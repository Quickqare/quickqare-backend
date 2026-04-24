const express = require("express");
const router = express.Router();

const partnerAuth = require("../middlewares/partnerAuth");

const {
  getWallet,
  getWalletHistory,
} = require("../controllers/partnerWallet.controller");

/* =====================================================
   PARTNER WALLET ROUTES (PRODUCTION READY)
   Base: /api/partner/wallet
===================================================== */

/**
 * ======================================
 * GET WALLET SUMMARY
 * GET /api/partner/wallet
 * ======================================
 */
router.get("/", partnerAuth, getWallet);

/**
 * ======================================
 * GET WALLET TRANSACTION HISTORY
 * GET /api/partner/wallet/history
 * ======================================
 */
router.get("/history", partnerAuth, getWalletHistory);

module.exports = router;