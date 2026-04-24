const router = require("express").Router();
const {
  listApplicableCoupons,
  validateCouponForAmount,
} = require("../services/coupon.service");

/* =====================================================
   AVAILABLE COUPONS
   GET /api/coupons/available?amount=1234
===================================================== */
router.get("/available", async (req, res) => {
  try {
    const amount = Number(req.query.amount || req.query.cartValue || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid amount is required",
      });
    }

    const coupons = await listApplicableCoupons({ amount });

    return res.json({
      success: true,
      coupons,
      count: coupons.length,
      amount,
    });
  } catch (error) {
    console.error("Available coupons error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch available coupons",
    });
  }
});

/* =====================================================
   APPLY COUPON
   POST /api/coupons/apply
===================================================== */
router.post("/apply", async (req, res) => {
  try {
    const code = String(req.body.code || "").trim();
    const amount = Number(req.body.amount || 0);
    const customerId = req.body.customerId || null;

    const result = await validateCouponForAmount({ code, amount, customerId });

    return res.json({
      success: true,
      discount: result.discount,
      finalAmount: result.finalAmount,
      coupon: result.response,
    });
  } catch (error) {
    console.error("Apply coupon error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Coupon apply failed",
    });
  }
});

module.exports = router;
