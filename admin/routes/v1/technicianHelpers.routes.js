const express = require("express");
const mongoose = require("mongoose");
const Partner = require("../../../models/Partner");
const TechnicianHelper = require("../../../models/TechnicianHelper");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { asSingleString, getPagination } = require("../../utils/common");
const { success, fail } = require("../../utils/response");
const { sendPushNotification } = require("../../../services/pushNotification.service");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.PARTNERS_APPROVE));

/* =====================================================
   LIST TECHNICIAN-HELPER RELATIONSHIPS
   GET /api/v1/admin/technician-helpers
   Query: status, technicianId, helperId, page, pageSize
===================================================== */
router.get("/", async (req, res) => {
  try {
    const status = String(asSingleString(req.query.status) || "").toUpperCase();
    const technicianId = asSingleString(req.query.technicianId);
    const helperId = asSingleString(req.query.helperId);
    const { page, pageSize, skip, limit } = getPagination(req);

    const where = {};
    if (["PENDING", "ACTIVE", "REJECTED", "REMOVED"].includes(status)) {
      where.status = status;
    }
    if (technicianId && mongoose.Types.ObjectId.isValid(technicianId)) {
      where.technician = technicianId;
    }
    if (helperId && mongoose.Types.ObjectId.isValid(helperId)) {
      where.helper = helperId;
    }

    const [rows, total] = await Promise.all([
      TechnicianHelper.find(where)
        .populate("technician", "name phone")
        .populate("helper", "name phone")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      TechnicianHelper.countDocuments(where),
    ]);

    const data = rows.map((r) => ({
      id: String(r._id),
      status: r.status,
      technicianId: r.technician ? String(r.technician._id) : null,
      technicianName: r.technician?.name || "(deleted)",
      technicianPhone: r.technician?.phone || "",
      helperId: r.helper ? String(r.helper._id) : null,
      helperName: r.helper?.name || "(deleted)",
      helperPhone: r.helper?.phone || r.invitePhone || "",
      invitedAt: r.invitedAt,
      respondedAt: r.respondedAt,
      removedAt: r.removedAt,
    }));

    return success(res, data, {
      requestId: req.requestId,
      pagination: { page, pageSize, total },
    });
  } catch (error) {
    return fail(res, 500, "TECH_HELPERS_LIST_FAILED", "Unable to fetch relationships", error.message, {
      requestId: req.requestId,
    });
  }
});

/* =====================================================
   UNLINK A HELPER (set REMOVED)
   POST /api/v1/admin/technician-helpers/:id/remove
===================================================== */
router.post("/:id/remove", audit("admin.technicianHelpers.remove"), async (req, res) => {
  try {
    const id = asSingleString(req.params.id);
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, "INVALID_ID", "Invalid relationship id", null, { requestId: req.requestId });
    }

    const row = await TechnicianHelper.findById(id)
      .populate("technician", "name fcmToken")
      .populate("helper", "name fcmToken");
    if (!row) {
      return fail(res, 404, "NOT_FOUND", "Relationship not found", null, { requestId: req.requestId });
    }
    if (row.status === "REMOVED") {
      return fail(res, 409, "ALREADY_REMOVED", "This relationship is already removed", null, {
        requestId: req.requestId,
      });
    }

    const technicianName = row.technician?.name || "a technician";
    const helperName = row.helper?.name || "a helper";

    row.status = "REMOVED";
    row.removedAt = new Date();
    row.removedBy = req.adminUser?.id || null;
    await row.save();

    if (row.helper?.fcmToken) {
      sendPushNotification(
        row.helper.fcmToken,
        "Helper Link Removed",
        `Admin removed your helper link with ${technicianName}.`,
        { type: "HELPER_LINK_REMOVED" }
      );
    }
    if (row.technician?.fcmToken) {
      sendPushNotification(
        row.technician.fcmToken,
        "Helper Removed",
        `Admin removed ${helperName} from your team.`,
        { type: "HELPER_REMOVED_BY_ADMIN" }
      );
    }

    return success(res, { id: String(row._id), status: row.status }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "TECH_HELPER_REMOVE_FAILED", "Unable to remove relationship", error.message, {
      requestId: req.requestId,
    });
  }
});

/* =====================================================
   REASSIGN A HELPER TO A DIFFERENT TECHNICIAN
   POST /api/v1/admin/technician-helpers/reassign
   Body: { helperId, newTechnicianId }
===================================================== */
router.post("/reassign", audit("admin.technicianHelpers.reassign"), async (req, res) => {
  try {
    const helperId = asSingleString(req.body.helperId);
    const newTechnicianId = asSingleString(req.body.newTechnicianId);

    if (
      !helperId ||
      !newTechnicianId ||
      !mongoose.Types.ObjectId.isValid(helperId) ||
      !mongoose.Types.ObjectId.isValid(newTechnicianId)
    ) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid helperId and newTechnicianId are required", null, {
        requestId: req.requestId,
      });
    }
    if (String(helperId) === String(newTechnicianId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Helper and technician cannot be the same partner", null, {
        requestId: req.requestId,
      });
    }

    const [helper, technician] = await Promise.all([
      Partner.findById(helperId).select("_id name fcmToken isBlocked").lean(),
      Partner.findById(newTechnicianId).select("_id name skillTier isBlocked fcmToken").lean(),
    ]);

    if (!helper) {
      return fail(res, 404, "NOT_FOUND", "Helper partner not found", null, { requestId: req.requestId });
    }
    if (!technician) {
      return fail(res, 404, "NOT_FOUND", "Technician partner not found", null, { requestId: req.requestId });
    }
    if (technician.isBlocked) {
      return fail(res, 400, "VALIDATION_ERROR", "Target technician account is blocked", null, {
        requestId: req.requestId,
      });
    }
    if (technician.skillTier !== 2) {
      return fail(res, 400, "VALIDATION_ERROR", "Target partner is not an AC technician", null, {
        requestId: req.requestId,
      });
    }

    // Capture the helper's current technician (for notification) before unlinking.
    const oldActive = await TechnicianHelper.findOne({
      helper: helperId,
      status: "ACTIVE",
    }).populate("technician", "name fcmToken");

    // Remove the helper's current active link, if any.
    await TechnicianHelper.updateMany(
      { helper: helperId, status: "ACTIVE" },
      { $set: { status: "REMOVED", removedAt: new Date(), removedBy: req.adminUser?.id || null } }
    );

    // Activate (or create) the link to the new technician.
    let row = await TechnicianHelper.findOne({ technician: newTechnicianId, helper: helperId });
    if (row) {
      row.status = "ACTIVE";
      row.respondedAt = new Date();
      row.removedAt = null;
      row.removedBy = null;
      await row.save();
    } else {
      row = await TechnicianHelper.create({
        technician: newTechnicianId,
        helper: helperId,
        status: "ACTIVE",
        respondedAt: new Date(),
      });
    }

    if (helper.fcmToken) {
      sendPushNotification(
        helper.fcmToken,
        "Reassigned to a Technician",
        `Admin assigned you as a helper for ${technician.name}.`,
        { type: "HELPER_REASSIGNED" }
      );
    }
    if (technician.fcmToken) {
      sendPushNotification(
        technician.fcmToken,
        "Helper Assigned",
        `Admin assigned ${helper.name} as your helper.`,
        { type: "HELPER_ASSIGNED_BY_ADMIN" }
      );
    }
    if (
      oldActive?.technician?.fcmToken &&
      String(oldActive.technician._id) !== String(newTechnicianId)
    ) {
      sendPushNotification(
        oldActive.technician.fcmToken,
        "Helper Reassigned",
        `Admin moved ${helper.name} to another technician.`,
        { type: "HELPER_MOVED_BY_ADMIN" }
      );
    }

    return success(
      res,
      { id: String(row._id), status: row.status, helperId, newTechnicianId },
      { requestId: req.requestId }
    );
  } catch (error) {
    return fail(res, 500, "TECH_HELPER_REASSIGN_FAILED", "Unable to reassign helper", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
