const express = require("express");
const router = express.Router();
const ProfessionalLead = require("../../../models/ProfessionalLead");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { success, fail } = require("../../utils/response");

// Gated behind PARTNERS_APPROVE — same admins who vet real partner
// applications review these callback requests too, rather than a new
// permission for what's still "prospective partner" work.
router.use(authenticateAdmin, authorize(PERMISSIONS.PARTNERS_APPROVE));

const STATUSES = ["NEW", "CONTACTED", "CONVERTED", "REJECTED"];

/**
 * GET /api/v1/admin/partner-leads?status=NEW&page=1&limit=20
 */
router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const filter = {};
    if (status && STATUSES.includes(String(status))) filter.status = status;

    const [leads, total] = await Promise.all([
      ProfessionalLead.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ProfessionalLead.countDocuments(filter),
    ]);

    return success(res, { leads, total, page, limit }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "LEADS_FETCH_FAILED", "Unable to fetch leads", error.message, {
      requestId: req.requestId,
    });
  }
});

/**
 * PATCH /api/v1/admin/partner-leads/:id/status
 */
router.patch("/:id/status", audit("admin.partnerLead.status"), async (req, res) => {
  try {
    const { status, notes } = req.body;
    if (!STATUSES.includes(status)) {
      return fail(res, 400, "VALIDATION_ERROR", `status must be one of ${STATUSES.join(", ")}`, null, {
        requestId: req.requestId,
      });
    }

    const update = { status };
    if (typeof notes === "string") update.notes = notes.trim().slice(0, 1000);
    if (status !== "NEW") {
      update.contactedBy = req.adminUser.id;
      update.contactedAt = new Date();
    }

    const lead = await ProfessionalLead.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!lead) {
      return fail(res, 404, "NOT_FOUND", "Lead not found", null, { requestId: req.requestId });
    }

    return success(res, lead, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "LEAD_UPDATE_FAILED", "Unable to update lead", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
