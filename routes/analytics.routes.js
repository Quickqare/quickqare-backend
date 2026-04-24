const express = require("express");
const router = express.Router();

const adminAuth = require("../middlewares/adminAuth");
const analyticsController = require("../controllers/analytics.controller");

/* =====================================================
   ADMIN ANALYTICS ROUTES (PRODUCTION READY)
===================================================== */

// protect all analytics routes
router.use(adminAuth);

/* =====================
   DASHBOARD OVERVIEW
   GET /api/admin/analytics/overview
===================== */
router.get("/overview", analyticsController.getOverview);

/* =====================
   TODAY STATS
   GET /api/admin/analytics/today
===================== */
router.get("/today", analyticsController.getTodayStats);

/* =====================
   BOOKING STATUS DISTRIBUTION
   GET /api/admin/analytics/booking-status
===================== */
router.get(
  "/booking-status",
  analyticsController.getBookingStatusStats
);

/* =====================
   PARTNER PERFORMANCE
   GET /api/admin/analytics/partner-performance
===================== */
router.get(
  "/partner-performance",
  analyticsController.getPartnerPerformance
);

module.exports = router;