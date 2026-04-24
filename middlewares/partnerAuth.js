const jwt = require("jsonwebtoken");
const Partner = require("../models/Partner");

/* =====================================================
   PARTNER AUTH MIDDLEWARE (PRODUCTION SAFE)
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
       VERIFY TOKEN
    ===================== */
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== "partner") {
      return res.status(403).json({
        success: false,
        message: "Partner access required",
      });
    }

    /* =====================
       FIND PARTNER
    ===================== */
    const partner = await Partner.findById(decoded.id).select("-password");

    if (!partner) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }

    /* =====================
       BLOCKED PARTNER CHECK
    ===================== */
    if (partner.isBlocked) {
      return res.status(403).json({
        success: false,
        message: "Your account has been blocked",
      });
    }

    /* =====================
       ATTACH PARTNER CONTEXT
    ===================== */
    req.partner = partner;

    next();
  } catch (error) {
    console.error("Partner auth error:", error);

    return res.status(401).json({
      success: false,
      message: "Unauthorized partner",
    });
  }
};