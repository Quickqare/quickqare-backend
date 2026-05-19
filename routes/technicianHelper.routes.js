const express = require("express");
const router = express.Router();

const partnerAuth = require("../middlewares/partnerAuth");
const ctrl = require("../controllers/technicianHelper.controller");

/* =====================================================
   TECHNICIAN ↔ HELPER ROUTES
   Base: /api/partner
   The same partner JWT is used whether the caller acts
   as a technician or as a helper.
===================================================== */

/* ---- Technician actions ---- */
router.post("/helpers/invite", partnerAuth, ctrl.inviteHelper);
router.get("/helpers", partnerAuth, ctrl.listHelpers);
router.post("/booking/helpers", partnerAuth, ctrl.setBookingHelpers);

/* ---- Helper actions ---- */
router.get("/helper/invitations", partnerAuth, ctrl.listInvitations);
router.post("/helper/invitations/respond", partnerAuth, ctrl.respondToInvitation);
router.get("/helper/jobs", partnerAuth, ctrl.listHelperJobs);

module.exports = router;
