const express = require("express");
const router = express.Router();

const zoneController = require("../controllers/zone.controller");

// Admin-panel JWT (ADMIN_JWT_ACCESS_SECRET) — the legacy shared-secret
// adminAuth middleware was removed; only real admin accounts pass this.
const adminAuth = require("../admin/middleware/authenticateAdmin");

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
    const { resolveZoneForPincode, resolveHubForLocation } = require("../services/zone.service");
    const { getUseH3Flag } = require("../services/assignmentEngine");
    const pincode = String(req.query.pincode || "").trim();
    if (!/^\d{6}$/.test(pincode)) {
      return res.status(400).json({ success: false, serviceable: false, message: "Invalid pincode" });
    }

    // H3 mode: pincode zones are disabled, so resolve serviceability against the
    // hub covering the pincode centroid (lenient ring fallback for boundary fuzz).
    // Mirrors the gate used in booking.controller.createBooking.
    const useH3 = await getUseH3Flag();
    if (useH3) {
      const { forwardGeocode } = require("../services/geocode.service");
      const geo = await forwardGeocode(pincode, "zone_check");
      let hub = null;
      if (geo.ok) {
        hub = await resolveHubForLocation(geo.lat, geo.lng, { ringFallback: true });
      }
      const serviceable = !!(hub && hub.isActive !== false && hub.customerAppEnabled !== false);
      return res.json({ success: true, serviceable, zoneName: hub?.name || null });
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