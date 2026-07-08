const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { readCookie, USER_TOKEN_COOKIE } = require("../utils/authCookie");

/* =====================================================
   USER AUTH MIDDLEWARE (PRODUCTION SAFE)
===================================================== */
module.exports = async (req, res, next) => {
  try {
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
      return res.status(401).json({
        success: false,
        message: "Authorization token required",
      });
    }

    /* =====================
       VERIFY JWT
    ===================== */
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired token",
      });
    }

    /* =====================
       SUPPORT id OR userId
    ===================== */
    const userId = decoded.id || decoded.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Invalid token payload",
      });
    }

    /* =====================
       ROLE CHECK (SAFE)
    ===================== */
    if (decoded.role && decoded.role !== "user") {
      return res.status(403).json({
        success: false,
        message: "User access required",
      });
    }

    /* =====================
       FIND USER
    ===================== */
    const user = await User.findById(userId).select("-password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }

    /* =====================
       BLOCKED USER CHECK
       A valid token alone isn't enough — re-check the account status on every
       request so an admin block takes effect immediately, instead of the user
       keeping access until their (90-day) token expires.
    ===================== */
    if (user.status === "BLOCKED") {
      return res.status(403).json({
        success: false,
        message: "Your account has been blocked. Please contact support.",
      });
    }

    /* =====================
       ATTACH USER CONTEXT
    ===================== */
    req.user = user;

    next();
  } catch (err) {
    console.error("User auth error:", err);

    return res.status(401).json({
      success: false,
      message: "Unauthorized user",
    });
  }
};