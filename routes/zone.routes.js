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
   GET /api/zones/check?pincode=500001[&lat=17.4&lng=78.4]
   Returns { serviceable: true/false, zoneName }

   When the caller supplies precise lat/lng (e.g. a browser that already has
   GPS), H3 mode uses those for strict exact-cell hub matching. Without coords
   it falls back to geocoding the pincode centroid + a lenient ring gate, which
   is coarser. Mirrors the gate used in booking.controller.createBooking.
*/
router.get("/check", async (req, res) => {
  try {
    const { resolveZoneForPincode, resolveHubForLocation } = require("../services/zone.service");
    const { getUseH3Flag } = require("../services/assignmentEngine");
    const pincode = String(req.query.pincode || "").trim();
    if (!/^\d{6}$/.test(pincode)) {
      return res.status(400).json({ success: false, serviceable: false, message: "Invalid pincode" });
    }

    // Optional precise coordinates from a GPS-capable client.
    const qLat = Number(req.query.lat);
    const qLng = Number(req.query.lng);
    const hasClientGps =
      Number.isFinite(qLat) &&
      Number.isFinite(qLng) &&
      qLat >= -90 && qLat <= 90 &&
      qLng >= -180 && qLng <= 180 &&
      (qLat !== 0 || qLng !== 0);

    const useH3 = await getUseH3Flag();
    if (useH3) {
      const { resolveBookingCategories } = require("../services/zone.service");
      // Optional service scoping: callers that pass ?serviceId= or ?category=
      // (id / slug / name) get a precise per-service answer; without it we report
      // area-level serviceability (any active hub here), as before.
      const neededCategories = await resolveBookingCategories({
        serviceId: req.query.serviceId,
        serviceCategory: req.query.category || req.query.serviceCategory,
      });
      const gateCategories = neededCategories.length ? neededCategories : [{ id: null }];

      // Resolve the lookup coordinates once.
      let baseLat = null;
      let baseLng = null;
      let ringFallback = false;
      if (hasClientGps) {
        // Precise GPS — strict exact-cell gate, no ring fuzz.
        baseLat = qLat;
        baseLng = qLng;
      } else {
        // No coords — geocode the pincode centroid and use the lenient ring gate.
        const { forwardGeocode } = require("../services/geocode.service");
        const geo = await forwardGeocode(pincode, "zone_check");
        if (geo.ok) {
          baseLat = geo.lat;
          baseLng = geo.lng;
          ringFallback = true;
        }
      }

      let serviceable = baseLat !== null;
      let zoneName = null;
      if (serviceable) {
        for (const cat of gateCategories) {
          const hub = await resolveHubForLocation(baseLat, baseLng, { ringFallback, categoryId: cat.id });
          if (!hub || hub.isActive === false || hub.customerAppEnabled === false) {
            serviceable = false;
            zoneName = null;
            break;
          }
          zoneName = hub.name;
        }
      }
      return res.json({ success: true, serviceable, zoneName });
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