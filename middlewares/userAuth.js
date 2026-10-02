const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { readCookie, USER_TOKEN_COOKIE } = require("../utils/authCookie");

/* =====================================================
   RESOLVE THE REQUEST'S CUSTOMER
   Shared by userAuth (rejects) and userAuth.optional (never rejects), so both
   apply exactly the same token rules. Returns { user } on success, otherwise
   { status, message } describing why the caller isn't a valid customer.
===================================================== */
async function resolveUser(req) {
  /* =====================
     EXTRACT TOKEN
     Mobile apps send the JWT as `Authorization: Bearer <token>`; the web app
     sends it as an httpOnly cookie. Accept either — Bearer takes precedence.
  ===================== */
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  }
  if (!token) {
    token = readCookie(req.headers.cookie, USER_TOKEN_COOKIE);
  }

  if (!token) {
    return { status: 401, message: "Authorization token required" };
  }

  /* =====================
     VERIFY JWT
  ===================== */
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return { status: 401, message: "Invalid or expired token" };
  }

  /* =====================
     SUPPORT id OR userId
  ===================== */
  const userId = decoded.id || decoded.userId;

  if (!userId) {
    return { status: 401, message: "Invalid token payload" };
  }

  /* =====================
     ROLE CHECK (SAFE)
     Current user tokens are signed { id, role: "user" }. Legacy tokens
     predate the role claim and carry only { userId } (no id) — still honored
     until they age out (90-day TTL). Everything else is rejected: a role that
     isn't "user", OR a role-less { id } token (which no current signer issues)
     — so a non-user token signed with JWT_SECRET can't slip through as a user.
  ===================== */
  if (decoded.role !== "user") {
    const isLegacyUserToken = !decoded.role && !decoded.id && decoded.userId;
    if (!isLegacyUserToken) {
      return { status: 403, message: "User access required" };
    }
  }

  /* =====================
     FIND USER
  ===================== */
  const user = await User.findById(userId).select("-password");

  if (!user) {
    return { status: 401, message: "User not found" };
  }

  /* =====================
     BLOCKED USER CHECK
     A valid token alone isn't enough — re-check the account status on every
     request so an admin block takes effect immediately, instead of the user
     keeping access until their (90-day) token expires.
  ===================== */
  if (user.status === "BLOCKED") {
    return {
      status: 403,
      message: "Your account has been blocked. Please contact support.",
    };
  }

  return { user };
}

/* =====================================================
   USER AUTH MIDDLEWARE (PRODUCTION SAFE)
===================================================== */
async function userAuth(req, res, next) {
  try {
    const result = await resolveUser(req);

    if (!result.user) {
      return res.status(result.status).json({
        success: false,
        message: result.message,
      });
    }

    /* =====================
       ATTACH USER CONTEXT
    ===================== */
    req.user = result.user;

    next();
  } catch (err) {
    console.error("User auth error:", err);

    return res.status(401).json({
      success: false,
      message: "Unauthorized user",
    });
  }
}

/* =====================================================
   OPTIONAL USER AUTH
   For public endpoints that show a signed-in customer a little more (e.g. their
   own personal coupons). Never rejects: a missing/invalid token or a blocked
   account simply proceeds anonymously, without req.user.
===================================================== */
userAuth.optional = async function optionalUserAuth(req, _res, next) {
  try {
    const result = await resolveUser(req);
    if (result.user) req.user = result.user;
  } catch {
    // A lookup failure just means "anonymous" on a public endpoint.
  }
  next();
};

module.exports = userAuth;
