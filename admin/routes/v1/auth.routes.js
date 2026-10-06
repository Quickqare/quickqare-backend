const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const AdminUser = require("../../models/AdminUser");
const AdminSession = require("../../models/AdminSession");
const AuditLog = require("../../models/AuditLog");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const audit = require("../../middleware/audit");
const {
  authLimiter,
  adminLoginLimiter,
  adminLoginDailyLimiter,
} = require("../../../middlewares/rateLimiter");
const { getPermissionsForRole } = require("../../constants/permissions");
const { asSingleString, adminPasswordProblem } = require("../../utils/common");
const { sendAdminTwoFaCode } = require("../../services/email.service");
const { success, fail } = require("../../utils/response");
const {
  CHALLENGE_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  SESSION_MAX_SECONDS,
  getAccessSecret,
  getRefreshSecret,
  signAccessToken,
  signRefreshToken,
  signChallengeToken,
} = require("../../utils/tokens");

const router = express.Router();

const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

// Max wrong 2FA codes allowed per challenge before it is locked (forces re-login).
const MAX_2FA_ATTEMPTS = 5;

// The auth outcomes that mean "it worked"; every other one is a failure in the
// activity log's Result column and filter.
const AUTH_OK = new Set(["password_ok_2fa_sent", "success"]);

// A session ends SESSION_MAX_SECONDS after it was started, whatever happens.
const sessionEndsAt = (session) => new Date(session.createdAt).getTime() + SESSION_MAX_SECONDS * 1000;
// Refreshing slides the expiry forward, but never past that end.
const nextRefreshExpiry = (session) =>
  new Date(Math.min(Date.now() + REFRESH_TTL_SECONDS * 1000, sessionEndsAt(session)));

const revokeSession = (sessionId) =>
  AdminSession.updateOne({ _id: sessionId }, { $set: { isRevoked: true, revokedAt: new Date() } });

// How the current refresh token is remembered on the session.
//
// bcrypt reads only the first 72 bytes of its input, and every refresh token
// (a JWT) begins with the same 72: the header plus `{"type":"refresh","sub":"…`.
// So a bcrypt hash of one refresh token matches ALL of them, and rotating the
// token never invalidated the old one. A coordinated session (see /refresh)
// stores a SHA-256 of the whole token instead — the right tool for a long,
// signed value. Sessions from older panel builds keep bcrypt and behave exactly
// as before: there, two open tabs share one token and depend on that.
const SHA256_PREFIX = "sha256:";
const refreshTokenDigest = (token) =>
  SHA256_PREFIX + crypto.createHash("sha256").update(token).digest("hex");

const hashRefreshToken = (token, coordinated) =>
  coordinated ? refreshTokenDigest(token) : bcrypt.hash(token, 10);

const refreshTokenMatches = (token, stored) => {
  if (!String(stored || "").startsWith(SHA256_PREFIX)) return bcrypt.compare(token, stored || "");
  const expected = Buffer.from(stored);
  const actual = Buffer.from(refreshTokenDigest(token));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

// Audit pre-auth attempts (login / 2FA) directly. The generic audit() middleware
// no-ops here because it runs before authentication (no req.adminUser yet), and
// it would also capture the raw request body — which includes the password. This
// helper logs only safe fields and never touches the password.
async function logAuthEvent(req, action, outcome, extra = {}) {
  try {
    await AuditLog.create({
      actorAdminId: extra.adminUserId || null,
      action,
      entityType: "admin.auth",
      entityId: null,
      requestId: req.requestId || "n/a",
      ipAddress: req.ip || "",
      userAgent: asSingleString(req.headers["user-agent"]) || "",
      metadata: JSON.stringify({ outcome, email: extra.email || null }),
      outcome: AUTH_OK.has(outcome) ? "success" : "failed",
    });
  } catch (error) {
    console.error("[admin:auth-audit] failed", error.message);
  }
}

router.post("/login", authLimiter, adminLoginLimiter, adminLoginDailyLimiter, async (req, res) => {
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
      await logAuthEvent(req, "admin.auth.login", "invalid_email", { email });
      return fail(res, 401, "INVALID_CREDENTIALS", "Invalid admin credentials", null, {
        requestId: req.requestId,
      });
    }

    const validPassword = await admin.verifyPassword(password);
    if (!validPassword) {
      await logAuthEvent(req, "admin.auth.login", "invalid_password", {
        email,
        adminUserId: String(admin._id),
      });
      return fail(res, 401, "INVALID_CREDENTIALS", "Invalid admin credentials", null, {
        requestId: req.requestId,
      });
    }

    // A fixed test code (and echoing it back as devCode) is a 2FA bypass — only
    // ever honour it outside production, regardless of whether the env is set.
    const allowTestCode = !IS_PRODUCTION && Boolean(process.env.ADMIN_2FA_TEST_CODE);
    const generatedCode = allowTestCode
      ? String(process.env.ADMIN_2FA_TEST_CODE)
      : String(crypto.randomInt(100000, 1000000)); // CSPRNG, always 6 digits
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

    await logAuthEvent(req, "admin.auth.login", "password_ok_2fa_sent", {
      email,
      adminUserId: String(admin._id),
    });

    const payload = {
      twoFaRequired: true,
      challengeToken,
      challengeExpiresAt,
      // Echo the code back only for the non-production test-code path.
      ...(allowTestCode && { devCode: generatedCode }),
    };

    return success(res, payload, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "ADMIN_LOGIN_FAILED", "Unable to login admin", error.message, {
      requestId: req.requestId,
    });
  }
});

router.post("/verify-2fa", authLimiter, async (req, res) => {
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

    // Reserve one attempt atomically BEFORE comparing the code, so the 6-digit
    // code can't be brute-forced within the challenge window. The counter used
    // to be read here and saved after the compare, which let any number of
    // parallel requests pass the cap together and all get their code checked.
    const session = await AdminSession.findOneAndUpdate(
      {
        _id: challengePayload.sid,
        isRevoked: false,
        challengeExpiresAt: { $gt: new Date() },
        twoFaAttempts: { $lt: MAX_2FA_ATTEMPTS },
      },
      { $inc: { twoFaAttempts: 1 } },
      { new: true }
    ).select("+twoFaCodeHash");

    if (!session) {
      // Either the attempts are used up, or the challenge is gone, expired or
      // already completed. The admin must start a fresh login (rate-limited).
      const current = await AdminSession.findById(challengePayload.sid).lean();
      if (current?.challengeExpiresAt && (current.twoFaAttempts || 0) >= MAX_2FA_ATTEMPTS) {
        await logAuthEvent(req, "admin.auth.verify-2fa", "locked_too_many_attempts", {
          adminUserId: String(challengePayload.sub),
        });
        return fail(res, 429, "TOO_MANY_2FA_ATTEMPTS", "Too many incorrect codes. Please log in again.", null, {
          requestId: req.requestId,
        });
      }
      return fail(res, 401, "CHALLENGE_EXPIRED", "2FA challenge expired", null, {
        requestId: req.requestId,
      });
    }

    const validCode = await bcrypt.compare(code, session.twoFaCodeHash || "");
    if (!validCode) {
      // That was the last allowed attempt — lock the challenge for good.
      if (session.twoFaAttempts >= MAX_2FA_ATTEMPTS) {
        await AdminSession.updateOne(
          { _id: session._id },
          { $set: { isRevoked: true, revokedAt: new Date() } }
        );
      }
      await logAuthEvent(req, "admin.auth.verify-2fa", "invalid_code", {
        adminUserId: String(challengePayload.sub),
      });
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

    const accessToken = signAccessToken({
      adminUserId: String(admin._id),
      role: admin.role,
      sessionId: String(session._id),
    });
    const refreshToken = signRefreshToken({
      adminUserId: String(admin._id),
      role: admin.role,
      sessionId: String(session._id),
    });
    // Sent by admin panel builds that keep every tab on one refresh token —
    // see the reuse check in /refresh.
    session.refreshCoordinated = req.body.refreshCoordinated === true;
    session.refreshTokenHash = await hashRefreshToken(refreshToken, session.refreshCoordinated);
    session.refreshExpiresAt = nextRefreshExpiry(session);
    session.twoFaCodeHash = null;
    session.challengeExpiresAt = null;
    session.twoFaAttempts = 0;
    await session.save();

    admin.lastLoginAt = new Date();
    await admin.save();

    await logAuthEvent(req, "admin.auth.verify-2fa", "success", {
      email: admin.email,
      adminUserId: String(admin._id),
    });

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

router.post("/refresh", authLimiter, async (req, res) => {
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

    if (Date.now() >= sessionEndsAt(session)) {
      await revokeSession(session._id);
      return fail(res, 401, "SESSION_EXPIRED", "Your session has ended. Please sign in again.", null, {
        requestId: req.requestId,
      });
    }

    const matches = await refreshTokenMatches(refreshToken, session.refreshTokenHash);
    if (!matches) {
      // A correctly signed token for this session that is no longer the current
      // one: it was rotated away, and someone is replaying it. When the admin
      // panel keeps all its tabs on one token that can only be a copy made
      // elsewhere, so the whole session is ended — the thief and the admin both
      // sign in again, and only the admin can. (A session from an older panel
      // build never gets here: its bcrypt hash matches any of its tokens.)
      if (session.refreshCoordinated) {
        await revokeSession(session._id);
        await logAuthEvent(req, "admin.auth.refresh", "refresh_token_reuse", {
          adminUserId: String(session.adminUserId),
        });
        return fail(res, 401, "REFRESH_REUSED", "This session was ended for security. Please sign in again.", null, {
          requestId: req.requestId,
        });
      }
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

    const nextAccessToken = signAccessToken({
      adminUserId: String(admin._id),
      role: admin.role,
      sessionId: String(session._id),
    });
    const nextRefreshToken = signRefreshToken({
      adminUserId: String(admin._id),
      role: admin.role,
      sessionId: String(session._id),
    });
    session.refreshTokenHash = await hashRefreshToken(nextRefreshToken, session.refreshCoordinated);
    session.refreshExpiresAt = nextRefreshExpiry(session);
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

// Change your own password. The current password is required even though the
// caller is signed in, so a borrowed session can't lock the real admin out.
// Every OTHER session of this admin is ended; the one making the call stays.
// Audited via logAuthEvent, never audit(): that would store the request body.
router.post("/change-password", authLimiter, authenticateAdmin, async (req, res) => {
  try {
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");

    const problem = adminPasswordProblem(newPassword);
    if (!currentPassword || problem) {
      return fail(res, 400, "VALIDATION_ERROR", problem || "Current password is required", null, {
        requestId: req.requestId,
      });
    }
    if (currentPassword === newPassword) {
      return fail(res, 400, "VALIDATION_ERROR", "New password must be different from the current one", null, {
        requestId: req.requestId,
      });
    }

    const admin = await AdminUser.findById(req.adminUser.id).select("+passwordHash");
    // 400, not 401: the admin client treats a 401 as an expired token and
    // would refresh + retry instead of showing this message.
    if (!admin || !(await admin.verifyPassword(currentPassword))) {
      await logAuthEvent(req, "admin.auth.change-password", "invalid_current_password", {
        email: req.adminUser.email,
        adminUserId: req.adminUser.id,
      });
      return fail(res, 400, "INVALID_CURRENT_PASSWORD", "Current password is incorrect", null, {
        requestId: req.requestId,
      });
    }

    admin.passwordHash = await AdminUser.hashPassword(newPassword);
    await admin.save();

    await AdminSession.updateMany(
      { adminUserId: admin._id, isRevoked: false, _id: { $ne: req.adminUser.sessionId } },
      { $set: { isRevoked: true, revokedAt: new Date() } }
    );

    await logAuthEvent(req, "admin.auth.change-password", "success", {
      email: admin.email,
      adminUserId: String(admin._id),
    });

    return success(res, { changed: true }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "CHANGE_PASSWORD_FAILED", "Unable to change password", error.message, {
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
