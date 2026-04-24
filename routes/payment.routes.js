const express = require("express");
const router = express.Router();

const { createOrder } = require("../controllers/payment.controller");
const {
  verifyRazorpayPayment,
} = require("../controllers/paymentVerify.controller");

const userAuth = require("../middlewares/userAuth");
const { apiLimiter } = require("../middlewares/rateLimiter");

/* =====================================================
   PAYMENT ROUTES (PRODUCTION READY)
   Base: /api/payment
===================================================== */

/**
 * ======================================
 * CREATE RAZORPAY ORDER
 * POST /api/payment/order
 * ======================================
 */
router.post(
  "/order",
  userAuth,
  apiLimiter,
  createOrder
);

/**
 * ======================================
 * VERIFY PAYMENT → TRIGGER ASSIGNMENT
 * POST /api/payment/verify
 * ======================================
 */
router.post(
  "/verify",
  userAuth,
  apiLimiter,
  verifyRazorpayPayment
);

module.exports = router;