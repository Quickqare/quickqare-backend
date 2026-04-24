const express = require("express");
const router = express.Router();

const serviceController = require("../controllers/service.controller");

// ⚠ enable later when admin panel ready
const adminAuth = require("../middlewares/adminAuth");

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
  adminAuth, // remove if testing locally
  serviceController.createService
);

/* UPDATE SERVICE
   PUT /api/services/:id
*/
router.put(
  "/:id",
  adminAuth,
  serviceController.updateService
);

/* DELETE SERVICE
   DELETE /api/services/:id
*/
router.delete(
  "/:id",
  adminAuth,
  serviceController.deleteService
);

module.exports = router;
