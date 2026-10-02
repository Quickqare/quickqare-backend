const router = require("express").Router();
const userAuth = require("../middlewares/userAuth");
const {
  listApplicableCoupons,
  validateCouponForAmount,
} = require("../services/coupon.service");

/* =====================================================
   AVAILABLE COUPONS
   GET /api/coupons/available?amount=1234
   Public. A signed-in customer (Bearer or web cookie) also sees their own
   personal coupons, e.g. a referral reward — nobody else's.
===================================================== */
router.get("/available", userAuth.optional, async (req, res) => {
  try {
    const amount = Number(req.query.amount || req.query.cartValue || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid amount is required",
      });
    }

    const rawServiceIds = req.query.serviceIds || "";
    const serviceIds = rawServiceIds ? String(rawServiceIds).split(",").filter(Boolean) : [];
    const coupons = await listApplicableCoupons({
      amount,
      serviceIds,
      customerId: req.user?._id || null,
    });

    // The list can include the caller's personal codes — never let a shared
    // cache (CDN/proxy) store it and serve it to someone else.
    res.set("Cache-Control", "private, no-store");

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
router.post("/apply", userAuth, async (req, res) => {
  try {
    const code = String(req.body.code || "").trim();
    const amount = Number(req.body.amount || 0);
    // customerId is taken from the authenticated session, NOT the request body.
    // Trusting a body-supplied customerId let a caller probe/spoof another
    // customer's per-customer redemption eligibility. Authoritative redemption
    // still happens at booking-create; this endpoint is now bound to the caller.
    const customerId = req.user?._id || null;
    const serviceIds = Array.isArray(req.body.serviceIds) ? req.body.serviceIds : [];

    const result = await validateCouponForAmount({ code, amount, customerId, serviceIds });

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
