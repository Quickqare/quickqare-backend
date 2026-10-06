const express = require("express");
const mongoose = require("mongoose");
const AdminUser = require("../../models/AdminUser");
const AdminSession = require("../../models/AdminSession");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { ADMIN_ROLES, PERMISSIONS } = require("../../constants/permissions");
const { asSingleString, adminPasswordProblem } = require("../../utils/common");
const { success, fail } = require("../../utils/response");

/*
 * Admin accounts — SuperAdmin only (admins.manage).
 *
 * Until this existed the only way to add an admin or change a password was the
 * ADMIN_BOOTSTRAP_* env vars, so the whole team shared one SuperAdmin login:
 * no per-person audit trail, and no way to remove one person's access.
 */

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.ADMINS_MANAGE));

const ROLES = Object.values(ADMIN_ROLES);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const toRow = (admin) => ({
  id: String(admin._id),
  name: admin.name,
  email: admin.email,
  role: admin.role,
  isActive: Boolean(admin.isActive),
  lastLoginAt: admin.lastLoginAt || null,
  createdAt: admin.createdAt,
});

// authenticateAdmin checks the session on every request, so ending an admin's
// sessions signs them out on their very next call.
const endSessions = (adminUserId) =>
  AdminSession.updateMany(
    { adminUserId, isRevoked: false },
    { $set: { isRevoked: true, revokedAt: new Date() } }
  );

router.get("/", async (req, res) => {
  try {
    const admins = await AdminUser.find().sort({ createdAt: 1 }).lean();
    return success(res, admins.map(toRow), { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "ADMINS_LIST_FAILED", "Unable to fetch admins", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post("/", audit("admin.admins.create"), async (req, res) => {
  try {
    const name = String(req.body.name || "").trim().slice(0, 80);
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = String(req.body.role || "");
    const password = String(req.body.password || "");

    if (!name || !EMAIL_RE.test(email) || email.length > 254) {
      return fail(res, 400, "VALIDATION_ERROR", "Name and a valid email are required", null, {
        requestId: req.requestId,
      });
    }
    if (!ROLES.includes(role)) {
      return fail(res, 400, "VALIDATION_ERROR", `role must be one of: ${ROLES.join(", ")}`, null, {
        requestId: req.requestId,
      });
    }
    const problem = adminPasswordProblem(password);
    if (problem) {
      return fail(res, 400, "VALIDATION_ERROR", problem, null, { requestId: req.requestId });
    }

    if (await AdminUser.exists({ email })) {
      return fail(res, 409, "EMAIL_TAKEN", "An admin with this email already exists", null, {
        requestId: req.requestId,
      });
    }

    const admin = await AdminUser.create({
      name,
      email,
      role,
      passwordHash: await AdminUser.hashPassword(password),
      isActive: true,
    });

    return success(res, toRow(admin), { requestId: req.requestId });
  } catch (error) {
    // Two creates racing past the exists() check: the unique index decides.
    if (error?.code === 11000) {
      return fail(res, 409, "EMAIL_TAKEN", "An admin with this email already exists", null, {
        requestId: req.requestId,
      });
    }
    return fail(res, 500, "ADMIN_CREATE_FAILED", "Unable to create admin", error.message, {
      requestId: req.requestId,
    });
  }
});

// Body: any of { name, role, isActive }.
router.patch("/:id", audit("admin.admins.update"), async (req, res) => {
  try {
    const adminId = asSingleString(req.params.id);
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return fail(res, 400, "INVALID_ID", "Invalid admin id", null, { requestId: req.requestId });
    }

    const patch = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name || "").trim().slice(0, 80);
      if (!name) {
        return fail(res, 400, "VALIDATION_ERROR", "Name can't be empty", null, { requestId: req.requestId });
      }
      patch.name = name;
    }
    if (req.body.role !== undefined) {
      if (!ROLES.includes(req.body.role)) {
        return fail(res, 400, "VALIDATION_ERROR", `role must be one of: ${ROLES.join(", ")}`, null, {
          requestId: req.requestId,
        });
      }
      patch.role = req.body.role;
    }
    if (req.body.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);

    const admin = await AdminUser.findById(adminId);
    if (!admin) {
      return fail(res, 404, "NOT_FOUND", "Admin not found", null, { requestId: req.requestId });
    }

    const roleChanges = patch.role !== undefined && patch.role !== admin.role;
    const disables = patch.isActive === false && admin.isActive;

    // The admin making the change stays an active SuperAdmin, so there is
    // always at least one left — nobody can lock the whole team out alone.
    if (adminId === req.adminUser.id && (roleChanges || disables)) {
      return fail(
        res,
        400,
        "SELF_CHANGE_NOT_ALLOWED",
        "You can't change your own role or disable your own account. Ask another SuperAdmin.",
        null,
        { requestId: req.requestId }
      );
    }

    Object.assign(admin, patch);
    await admin.save();

    // A new role means new permissions: sign them out so their panel reloads
    // with the right menu. A disabled admin is signed out everywhere.
    if (roleChanges || disables) await endSessions(admin._id);

    return success(res, toRow(admin), { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "ADMIN_UPDATE_FAILED", "Unable to update admin", error.message, {
      requestId: req.requestId,
    });
  }
});

// Set a new password for ANOTHER admin (forgotten password, or cutting off
// access). Your own goes through /auth/change-password, which asks for the
// current one.
router.post("/:id/password", audit("admin.admins.password"), async (req, res) => {
  try {
    const adminId = asSingleString(req.params.id);
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return fail(res, 400, "INVALID_ID", "Invalid admin id", null, { requestId: req.requestId });
    }
    if (adminId === req.adminUser.id) {
      return fail(res, 400, "USE_CHANGE_PASSWORD", "Use Change Password for your own account", null, {
        requestId: req.requestId,
      });
    }

    const password = String(req.body.password || "");
    const problem = adminPasswordProblem(password);
    if (problem) {
      return fail(res, 400, "VALIDATION_ERROR", problem, null, { requestId: req.requestId });
    }

    const admin = await AdminUser.findByIdAndUpdate(
      adminId,
      { $set: { passwordHash: await AdminUser.hashPassword(password) } },
      { new: true }
    );
    if (!admin) {
      return fail(res, 404, "NOT_FOUND", "Admin not found", null, { requestId: req.requestId });
    }

    await endSessions(admin._id);

    return success(res, toRow(admin), { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "ADMIN_PASSWORD_FAILED", "Unable to set password", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
