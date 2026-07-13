const express = require("express");
const router = express.Router();

const serviceController = require("../controllers/service.controller");

// Admin-panel JWT (ADMIN_JWT_ACCESS_SECRET) — the legacy shared-secret
// adminAuth middleware was removed; only real admin accounts pass this.
const adminAuth = require("../admin/middleware/authenticateAdmin");
const authorize = require("../admin/middleware/authorize");
const { PERMISSIONS } = require("../admin/constants/permissions");

/* =====================================================
   SERVICE ROUTES (PRODUCTION READY)
   Base: /api/services
===================================================== */

/**
 * ======================================
 * PUBLIC ROUTES
 * ======================================
 */

/* GET ALL SERVICES
   GET /api/services
*/
router.get("/", serviceController.getServices);

/* GET ALL CATEGORIES
   GET /api/services/categories
*/
router.get("/categories", serviceController.getCategories);

/* GET ALL SUBCATEGORIES
   GET /api/services/subcategories?categoryId=...
*/
router.get("/subcategories", serviceController.getSubCategories);

/**
 * ======================================
 * ADMIN ROUTES (PROTECTED)
 * ======================================
 */

/* CREATE SERVICE
   POST /api/services
*/
router.post(
  "/",
  adminAuth,
  authorize(PERMISSIONS.SERVICES_MANAGE),
  serviceController.createService
);

/* UPDATE SERVICE
   PUT /api/services/:id
*/
router.put(
  "/:id",
  adminAuth,
  authorize(PERMISSIONS.SERVICES_MANAGE),
  serviceController.updateService
);

/* DELETE SERVICE
   DELETE /api/services/:id
*/
router.delete(
  "/:id",
  adminAuth,
  authorize(PERMISSIONS.SERVICES_MANAGE),
  serviceController.deleteService
);

module.exports = router;
