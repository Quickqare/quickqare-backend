const express = require("express");
const requestContext = require("../../middleware/requestContext");
const authRoutes = require("./auth.routes");
const dashboardRoutes = require("./dashboard.routes");
const customersRoutes = require("./customers.routes");
const partnersRoutes = require("./partners.routes");
const technicianHelpersRoutes = require("./technicianHelpers.routes");
const servicesRoutes = require("./services.routes");
const bookingsRoutes = require("./bookings.routes");
const paymentsRoutes = require("./payments.routes");
const disputesRoutes = require("./disputes.routes");
const couponsRoutes = require("./coupons.routes");
const analyticsRoutes = require("./analytics.routes");
const rolesRoutes = require("./roles.routes");
const zonesRoutes = require("./zones.routes");
const bannersRoutes = require("./banners.routes");
const settingsRoutes = require("./settings.routes");
const reportsRoutes = require("./reports.routes");
const referralsRoutes = require("./referrals.routes");
const complaintsRoutes = require("./complaints.routes");
const catalogRoutes = require("./catalog.routes");
const policiesRoutes = require("./policies.routes");
const testResetRoutes = require("./testReset.routes");
const apiStatsRoutes = require("./apiStats.routes");
const offersRoutes = require("./offers.routes");
const { success } = require("../../utils/response");

const router = express.Router();

router.use(requestContext);

router.get("/health", (req, res) => {
  return success(res, { ok: true, module: "admin-v1" }, { requestId: req.requestId });
});

router.use("/auth", authRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/customers", customersRoutes);
router.use("/partners", partnersRoutes);
router.use("/technician-helpers", technicianHelpersRoutes);
router.use("/services", servicesRoutes);
router.use("/bookings", bookingsRoutes);
router.use("/payments", paymentsRoutes);
router.use("/disputes", disputesRoutes);
router.use("/coupons", couponsRoutes);
router.use("/analytics", analyticsRoutes);
router.use("/reports", reportsRoutes);
router.use("/zones", zonesRoutes);
router.use("/banners", bannersRoutes);
router.use("/", settingsRoutes);
router.use("/", rolesRoutes);
router.use("/referrals", referralsRoutes);
router.use("/complaints", complaintsRoutes);
router.use("/catalog", catalogRoutes);
router.use("/policies", policiesRoutes);
router.use("/test-reset", testResetRoutes);
router.use("/api-stats", apiStatsRoutes);
router.use("/offers", offersRoutes);

module.exports = router;
