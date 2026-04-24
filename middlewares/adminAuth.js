const jwt = require("jsonwebtoken");

/* =====================================================
   ADMIN AUTH MIDDLEWARE (PRODUCTION SAFE)
===================================================== */
module.exports = (req, res, next) => {
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
       VERIFY TOKEN
    ===================== */
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    /* =====================
       CHECK ADMIN ROLE
    ===================== */
    if (decoded.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    /* =====================
       ATTACH ADMIN CONTEXT
    ===================== */
    req.admin = {
      id: decoded.id || null,
      role: decoded.role,
    };

    next();
  } catch (err) {
    console.error("Admin auth error:", err);

    return res.status(401).json({
      success: false,
      message: "Unauthorized admin",
    });
  }
};