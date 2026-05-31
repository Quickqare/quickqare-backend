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

/* PUBLIC PINCODE SERVICEABILITY CHECK — no auth required
   GET /api/zones/check?pincode=500001
   Returns { serviceable: true/false, zoneName }
*/
router.get("/check", async (req, res) => {
  try {
    const { resolveZoneForPincode } = require("../services/zone.service");
    const pincode = String(req.query.pincode || "").trim();
    if (!/^\d{6}$/.test(pincode)) {
      return res.status(400).json({ success: false, serviceable: false, message: "Invalid pincode" });
    }
    const zone = await resolveZoneForPincode(pincode);
    const serviceable = !!(zone && zone.isActive !== false && zone.customerAppEnabled !== false);
    return res.json({ success: true, serviceable, zoneName: zone?.name || null });
  } catch (err) {
    return res.status(500).json({ success: false, serviceable: false });
  }
});

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