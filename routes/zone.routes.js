const express = require("express");
const router = express.Router();

const zoneController = require("../controllers/zone.controller");

// enable when admin panel fully active
const adminAuth = require("../middlewares/adminAuth");

/* =====================================================
   ZONE ROUTES (PRODUCTION READY)
   Base: /api/zones
===================================================== */

/**
 * ======================================
 * PUBLIC / READ ROUTES
 * ======================================
 */

/* GET ALL ZONES
   GET /api/zones
*/
router.get("/", zoneController.getZones);

/* GET SINGLE ZONE
   GET /api/zones/:id
*/
router.get("/:id", zoneController.getZone);

/**
 * ======================================
 * ADMIN ROUTES (PROTECTED)
 * ======================================
 */

/* CREATE ZONE
   POST /api/zones
*/
router.post(
  "/",
  adminAuth,
  zoneController.createZone
);

/* UPDATE ZONE
   PUT /api/zones/:id
*/
router.put(
  "/:id",
  adminAuth,
  zoneController.updateZone
);

/* DELETE ZONE
   DELETE /api/zones/:id
*/
router.delete(
  "/:id",
  adminAuth,
  zoneController.deleteZone
);

module.exports = router;