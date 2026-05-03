const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const AdminUser = require("../../models/AdminUser");
const AdminSession = require("../../models/AdminSession");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const audit = require("../../middleware/audit");
const { getPermissionsForRole } = require("../../constants/permissions");
const { asSingleString } = require("../../utils/common");
const { sendAdminTwoFaCode } = require("../../services/email.service");
const { success, fail } = require("../../utils/response");
const {
  CHALLENGE_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  getAccessSecret,
  getRefreshSecret,
  signAccessToken,
  signRefreshToken,
  signChallengeToken,
} = require("../../utils/tokens");

const router = express.Router();

router.post("/login", audit("admin.auth.login"), async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
      return fail(res, 400, "VALIDATION_ERROR", "Email and password are required", null, {
        requestId: req.requestId,
      });
    }

    const admin = await AdminUser.findOne({ email, isActive: true }).select("+passwordHash");
    if (!admin) {
      return fail(res, 401, "INVALID_CREDENTIALS", "Invalid admin credentials", null, {
        requestId: req.requestId,
      });
    }

    const validPassword = await admin.verifyPassword(password);
    if (!validPassword) {
      return fail(res, 401, "INVALID_CREDENTIALS", "Invalid admin credentials", null, {
        requestId: req.requestId,
      });
    }

    const randomCode = String(Math.floor(100000 + Math.random() * 900000));
    const generatedCode = process.env.ADMIN_2FA_TEST_CODE || randomCode;
    const twoFaCodeHash = await bcrypt.hash(generatedCode, 10);

    const challengeExpiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);
    const session = await AdminSession.create({
      adminUserId: admin._id,
      twoFaCodeHash,
      challengeExpiresAt,
      ipAddress: req.ip || "",
      userAgent: asSingleString(req.headers["user-agent"]) || "",
      isRevoked: false,
    });

    const challengeToken = signChallengeToken({
      adminUserId: String(admin._id),
      sessionId: String(session._id),
    });

    // Send code via email; fall back to console if Resend is not configured
    if (process.env.RESEND_API_KEY) {
      sendAdminTwoFaCode(email, generatedCode).catch((err) =>
        console.error("[admin-2fa] email failed:", err.message)
      );
    } else {
      console.log(`[admin-2fa] code for ${email}: ${generatedCode}`);
    }

    const payload = {
      twoFaRequired: true,
      challengeToken,
      challengeExpiresAt,
      // Include devCode only when a fixed test code is explicitly set
      ...(process.env.ADMIN_2FA_TEST_CODE && { devCode: generatedCode }),
    };

    return success(res, payload, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "ADMIN_LOGIN_FAILED", "Unable to login admin", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post("/verify-2fa", audit("admin.auth.verify-2fa"), async (req, res) => {
  try {
    const challengeToken = String(req.body.challengeToken || "");
    const code = String(req.body.code || "");

    if (!challengeToken || !code) {
      return fail(res, 400, "VALIDATION_ERROR", "challengeToken and code are required", null, {
        requestId: req.requestId,
      });
    }

    const challengePayload = jwt.verify(challengeToken, getAccessSecret());
    if (challengePayload.type !== "admin_2fa_challenge") {
      return fail(res, 401, "INVALID_CHALLENGE", "Invalid challenge token", null, {
        requestId: req.requestId,
      });
    }

    const session = await AdminSession.findById(challengePayload.sid).select("+twoFaCodeHash");
    if (!session || session.isRevoked || !session.challengeExpiresAt || session.challengeExpiresAt < new Date()) {
      return fail(res, 401, "CHALLENGE_EXPIRED", "2FA challenge expired", null, {
        requestId: req.requestId,
      });
    }

    const validCode = await bcrypt.compare(code, session.twoFaCodeHash || "");
    if (!validCode) {
      return fail(res, 401, "INVALID_2FA_CODE", "Invalid 2FA code", null, {
        requestId: req.requestId,
      });
    }

    const admin = await AdminUser.findById(challengePayload.sub);
    if (!admin || !admin.isActive) {
      return fail(res, 401, "ADMIN_INACTIVE", "Admin account inactive", null, {
        requestId: req.requestId,
      });
    }

    const accessToken = signAccessToken({ adminUserId: String(admin._id), role: admin.role });
    const refreshToken = signRefreshToken({
      adminUserId: String(admin._id),
      role: admin.role,
      sessionId: String(session._id),
    });
    const refreshTokenHash = await bcrypt.hash(refreshToken, 10);

    session.refreshTokenHash = refreshTokenHash;
    session.refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
    session.twoFaCodeHash = null;
    session.challengeExpiresAt = null;
    await session.save();

    admin.lastLoginAt = new Date();
    await admin.save();

    return success(
      res,
      {
        accessToken,
        refreshToken,
        admin: {
          id: String(admin._id),
          email: admin.email,
          role: admin.role,
          permissions: getPermissionsForRole(admin.role),
        },
      },
      { requestId: req.requestId }
    );
  } catch (error) {
    return fail(res, 401, "VERIFY_2FA_FAILED", "Unable to verify 2FA", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post("/refresh", audit("admin.auth.refresh"), async (req, res) => {
  try {
    const refreshToken = String(req.body.refreshToken || "");
    if (!refreshToken) {
      return fail(res, 400, "VALIDATION_ERROR", "refreshToken is required", null, {
        requestId: req.requestId,
      });
    }

    const refreshPayload = jwt.verify(refreshToken, getRefreshSecret());
    if (refreshPayload.type !== "refresh") {
      return fail(res, 401, "INVALID_REFRESH", "Invalid refresh token", null, {
        requestId: req.requestId,
      });
    }

    const session = await AdminSession.findById(refreshPayload.sid).select("+refreshTokenHash");
    if (!session || session.isRevoked || !session.refreshExpiresAt || session.refreshExpiresAt < new Date()) {
      return fail(res, 401, "REFRESH_EXPIRED", "Refresh token expired", null, {
        requestId: req.requestId,
      });
    }

    const matches = await bcrypt.compare(refreshToken, session.refreshTokenHash || "");
    if (!matches) {
      return fail(res, 401, "REFRESH_MISMATCH", "Refresh token mismatch", null, {
        requestId: req.requestId,
      });
    }

    const admin = await AdminUser.findById(refreshPayload.sub);
    if (!admin || !admin.isActive) {
      return fail(res, 401, "ADMIN_INACTIVE", "Admin account inactive", null, {
        requestId: req.requestId,
      });
    }

    const nextAccessToken = signAccessToken({ adminUserId: String(admin._id), role: admin.role });
    const nextRefreshToken = signRefreshToken({
      adminUserId: String(admin._id),
      role: admin.role,
      sessionId: String(session._id),
    });
    session.refreshTokenHash = await bcrypt.hash(nextRefreshToken, 10);
    session.refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
    await session.save();

    return success(
      res,
      {
        accessToken: nextAccessToken,
        refreshToken: nextRefreshToken,
      },
      { requestId: req.requestId }
    );
  } catch (error) {
    return fail(res, 401, "REFRESH_FAILED", "Unable to refresh session", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post("/logout", authenticateAdmin, audit("admin.auth.logout"), async (req, res) => {
  try {
    const refreshToken = String(req.body.refreshToken || "");
    if (!refreshToken) {
      await AdminSession.updateMany(
        { adminUserId: req.adminUser.id, isRevoked: false },
        { $set: { isRevoked: true, revokedAt: new Date() } }
      );
      return success(res, { revokedAll: true }, { requestId: req.requestId });
    }

    const refreshPayload = jwt.verify(refreshToken, getRefreshSecret());
    await AdminSession.updateOne(
      { _id: refreshPayload.sid, adminUserId: req.adminUser.id, isRevoked: false },
      { $set: { isRevoked: true, revokedAt: new Date() } }
    );

    return success(res, { revokedAll: false }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 400, "LOGOUT_FAILED", "Unable to logout session", error.message, {
      requestId: req.requestId,
    });
  }
});

router.get("/me", authenticateAdmin, async (req, res) => {
  return success(
    res,
    {
      id: req.adminUser.id,
      email: req.adminUser.email,
      role: req.adminUser.role,
      permissions: req.adminUser.permissions,
    },
    { requestId: req.requestId }
  );
});

module.exports = router;
