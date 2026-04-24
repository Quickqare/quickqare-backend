const jwt = require("jsonwebtoken");
const User = require("../models/User");

/* =====================================================
   USER AUTH MIDDLEWARE (PRODUCTION SAFE)
===================================================== */
module.exports = async (req, res, next) => {
  try {
    /* =====================
       CHECK AUTH HEADER
    ===================== */
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authorization token required",
      });
    }

    /* =====================
       EXTRACT TOKEN
    ===================== */
    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Invalid authorization format",
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