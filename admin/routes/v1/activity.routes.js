const express = require("express");
const mongoose = require("mongoose");
const AuditLog = require("../../models/AuditLog");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const { PERMISSIONS } = require("../../constants/permissions");
const { asSingleString, getPagination, escapeRegex } = require("../../utils/common");
const { success, fail } = require("../../utils/response");

/*
 * Admin activity log — the read side of the audit trail (SuperAdmin only).
 * Entries have been written for every admin action and sign-in attempt all
 * along (middleware/audit.js, auth.routes logAuthEvent); until this route
 * nothing could read them without opening the database.
 */

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.ACTIVITY_READ));

const parseJson = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

// GET /api/v1/admin/activity?page=&q=<action contains>&outcome=success|failed&adminId=
router.get("/", async (req, res) => {
  try {
    const { page, pageSize, skip, limit } = getPagination(req, { page: 1, pageSize: 50, maxPageSize: 100 });

    const where = {};
    const q = String(asSingleString(req.query.q) || "").trim();
    if (q) where.action = { $regex: escapeRegex(q), $options: "i" };
    const outcome = asSingleString(req.query.outcome);
    if (outcome === "success" || outcome === "failed") where.outcome = outcome;
    const adminId = asSingleString(req.query.adminId);
    if (adminId && mongoose.Types.ObjectId.isValid(adminId)) where.actorAdminId = adminId;

    const [rows, total] = await Promise.all([
      AuditLog.find(where)
        // _id is creation-ordered and always indexed; createdAt is not.
        .sort({ _id: -1 })
        .skip(skip)
        .limit(limit)
        .populate("actorAdminId", "name email")
        .lean(),
      AuditLog.countDocuments(where),
    ]);

    const data = rows.map((row) => {
      // Sign-in entries keep { outcome, email } here; action entries the query.
      const metadata = parseJson(row.metadata) || {};
      return {
        id: String(row._id),
        at: row.createdAt,
        actor: row.actorAdminId
          ? { id: String(row.actorAdminId._id), name: row.actorAdminId.name, email: row.actorAdminId.email }
          : null,
        // A failed sign-in has no admin to attach — only the email that was tried.
        attemptedEmail: metadata.email || null,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        outcome: row.outcome,
        statusCode: row.statusCode,
        detail: typeof metadata.outcome === "string" ? metadata.outcome : null,
        ipAddress: row.ipAddress,
        body: parseJson(row.afterState)?.body ?? null,
      };
    });

    return success(res, data, { requestId: req.requestId, pagination: { page, pageSize, total } });
  } catch (error) {
    return fail(res, 500, "ACTIVITY_LIST_FAILED", "Unable to fetch the activity log", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
